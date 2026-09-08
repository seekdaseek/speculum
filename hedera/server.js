// speculum — paid check service on Hedera
//
// Sells the gate by the call. An agent posts what it says it is about to do
// and the calldata it is about to sign, pays in HBAR, and gets the verdict.
// No account, no API key, no subscription.
//
// Pricing is metered rather than flat, because the work is not constant. A
// decode-only check is pure computation. A check with simulation costs an RPC
// round trip against live chain state, so it costs more. Charging one flat
// price for both would either overcharge the cheap call or subsidise the
// expensive one.
//
//   HEDERA_ACCOUNT_ID=0.0.x node hedera/server.js
//
// The service holds no key for payments. It quotes a price, hands the payment
// payload to the facilitator to verify and settle, and only then does the
// work. The one key it can hold is an operator key for the audit trail, so
// that every paid verdict is written to HCS with the settlement that paid for
// it; without HEDERA_OPERATOR_ID, HEDERA_OPERATOR_KEY and HEDERA_TOPIC_ID the
// service runs with the trail off and says so in its descriptor.

import express from 'express';
import { Gate } from '../src/gate.js';
import { jsonRpc } from '../src/simulate.js';
import { HBAR_ASSET_ID, HEDERA_TESTNET_CAIP2 } from '@x402/hedera';
import { outcomeOf, effectsOf, plain } from './verdict.js';
import { HcsAudit, auditRecord, MIRROR } from './audit.js';

const FACILITATOR = process.env.FACILITATOR ?? 'https://api.testnet.blocky402.com';
const PAY_TO = process.env.HEDERA_ACCOUNT_ID;
const PORT = Number(process.env.PORT ?? 4021);
const RPC = process.env.RPC_URL ?? null;
const TOPIC = process.env.HEDERA_TOPIC_ID ?? null;

if (!PAY_TO) {
  console.error('set HEDERA_ACCOUNT_ID to the account that receives payment, e.g. 0.0.12345');
  process.exit(1);
}

// Tinybars. 100,000,000 tinybars = 1 HBAR.
export const PRICES = {
  decode: 100_000n,      // 0.001 HBAR — decode and compare, no network
  simulated: 500_000n,   // 0.005 HBAR — adds an eth_simulateV1 round trip
};

// The audit trail is on only when everything it needs is present. A half
// configured trail that silently skipped writes would be a record that lies
// by omission, so it is all or nothing, and the descriptor says which.
let audit = null;
if (process.env.HEDERA_OPERATOR_ID && process.env.HEDERA_OPERATOR_KEY && TOPIC) {
  audit = new HcsAudit({
    operatorId: process.env.HEDERA_OPERATOR_ID,
    operatorKey: process.env.HEDERA_OPERATOR_KEY,
    topicId: TOPIC,
    network: 'testnet',
  });
}

const app = express();
app.use(express.json({ limit: '256kb' }));

/** Ask the facilitator what it accepts, rather than assuming it still accepts Hedera. */
async function feePayer() {
  const r = await fetch(`${FACILITATOR}/supported`);
  if (!r.ok) throw new Error(`facilitator /supported returned ${r.status}`);
  const j = await r.json();
  const kind = j.kinds?.find((k) => k.network === HEDERA_TESTNET_CAIP2);
  if (!kind) throw new Error('facilitator no longer advertises hedera:testnet');
  const fp = kind.extra?.feePayer ?? j.signers?.['hedera:*']?.[0];
  if (!fp) throw new Error('facilitator advertises hedera:testnet with no fee payer');
  return fp;
}

function requirementsFor(tier, fp) {
  return {
    scheme: 'exact',
    network: HEDERA_TESTNET_CAIP2,
    amount: PRICES[tier].toString(),
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    asset: HBAR_ASSET_ID,
    extra: { feePayer: fp },
    resource: `/check?tier=${tier}`,
    description:
      tier === 'simulated'
        ? 'intent versus calldata, including a simulated balance check against live state'
        : 'intent versus calldata',
  };
}

const auditDescriptor = () =>
  audit
    ? { hcs: true, topic: audit.topicId, mirror: `${MIRROR.testnet}/api/v1/topics/${audit.topicId}/messages` }
    : { hcs: false, reason: 'set HEDERA_OPERATOR_ID, HEDERA_OPERATOR_KEY and HEDERA_TOPIC_ID' };

// Service descriptor, so an agent can find out what this is and what it costs
// before spending anything.
app.get('/', async (_req, res) => {
  res.json({
    service: 'speculum',
    what: 'checks whether a declared intent matches the transaction about to be signed',
    endpoint: 'POST /check',
    payment: { protocol: 'x402', version: 2, network: HEDERA_TESTNET_CAIP2, facilitator: FACILITATOR },
    pricing: {
      unit: 'tinybar',
      metered: true,
      tiers: [
        { tier: 'decode', amount: PRICES.decode.toString(), covers: 'decode and compare' },
        { tier: 'simulated', amount: PRICES.simulated.toString(), covers: 'adds a live balance simulation' },
      ],
    },
    verdicts: ['PASS', 'BLOCK', 'REFUSE'],
    outcomes: ['match', 'divergence', 'undeterminable'],
    audit: auditDescriptor(),
    source: 'https://github.com/seekdaseek/speculum',
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, facilitator: FACILITATOR, payTo: PAY_TO, audit: auditDescriptor() });
});

app.post('/check', async (req, res) => {
  const { intent, tx, simulate, from } = req.body ?? {};
  if (!intent || !tx) return res.status(400).json({ error: 'send { intent, tx }' });

  const wantsSimulation = simulate === true && RPC && from;
  const tier = wantsSimulation ? 'simulated' : 'decode';

  let fp;
  try {
    fp = await feePayer();
  } catch (err) {
    // Cannot quote a price without knowing who the facilitator's fee payer is,
    // and quoting one anyway would produce a payload that fails at settlement.
    return res.status(503).json({ error: String(err.message) });
  }

  const requirements = requirementsFor(tier, fp);
  const header = req.get('X-PAYMENT');

  if (!header) {
    return res.status(402).json({
      x402Version: 2,
      error: 'payment required',
      accepts: [requirements],
    });
  }

  let paymentPayload;
  try {
    paymentPayload = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'X-PAYMENT is not base64 encoded JSON' });
  }

  // The client states what it agreed to pay. Charge against OUR requirements,
  // not theirs, or a client could declare a price of its own choosing. This is
  // the same failure the whole project is about: never take the caller's
  // description of what it is doing as the thing being checked.
  const body = { x402Version: 2, paymentPayload, paymentRequirements: requirements };

  const verify = await fetch(`${FACILITATOR}/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

  if (!verify.isValid) {
    return res.status(402).json({
      error: 'payment did not verify',
      reason: verify.invalidMessage ?? verify.invalidReason ?? null,
      accepts: [requirements],
    });
  }

  const settle = await fetch(`${FACILITATOR}/settle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

  if (!settle.success) {
    return res.status(402).json({
      error: 'settlement failed',
      reason: settle.errorMessage ?? settle.errorReason ?? null,
    });
  }

  const paid = {
    amount: requirements.amount,
    asset: requirements.asset,
    settlement: settle.transaction,
    network: settle.network ?? HEDERA_TESTNET_CAIP2,
    payer: settle.payer ?? verify.payer ?? null,
    payTo: PAY_TO,
  };
  console.log(`settled ${paid.settlement}  ${paid.amount} tinybar from ${paid.payer} for a ${tier} check`);

  // Paid. Now do the work.
  const gate = new Gate({ rpc: wantsSimulation ? jsonRpc(RPC) : null });

  let result;
  try {
    result = await gate.check(reviveBig(intent), reviveBig(tx), { from });
  } catch (err) {
    // The payment already settled, so say plainly that the work failed rather
    // than returning a verdict nobody computed.
    console.error(`check failed after ${paid.settlement} settled: ${err.message}`);
    return res.status(500).json({
      error: 'check failed after payment settled',
      reason: String(err.message),
      settlement: paid.settlement,
    });
  }

  // The verdict lands on HCS before it is returned, so the record exists by
  // the time anyone can act on the answer. If the write fails the verdict is
  // still the agent's, it paid for it, but the response says the trail has
  // a hole in it rather than pretending the write happened.
  let auditOut = null;
  if (audit) {
    const rec = auditRecord({
      intentHash: result.intentHash,
      deedHash: result.deedHash,
      level: result.level,
      findings: result.findings,
      tier,
      paid,
      network: paid.network,
    });
    try {
      auditOut = await audit.write(rec);
      console.log(`audited  ${auditOut.topicId} #${auditOut.sequenceNumber}  ${result.level} for ${paid.settlement}`);
    } catch (err) {
      auditOut = { topicId: audit.topicId, error: String(err.message) };
      console.error(`audit write failed for ${paid.settlement}: ${err.message}`);
    }
  }

  res.set('X-PAYMENT-RESPONSE', Buffer.from(JSON.stringify({
    success: true, transaction: settle.transaction, network: settle.network,
  })).toString('base64'));

  res.json({
    verdict: result.level,
    outcome: outcomeOf(result.level),
    divergence: result.level === 'BLOCK' ? result.findings.map((f) => f.code) : null,
    irreversible: result.irreversible,
    needsHuman: result.needsHuman,
    findings: result.findings.map((f) => ({ code: f.code, why: f.why, detail: f.detail ?? null })),
    effects: effectsOf(result.deed),
    intentHash: result.intentHash,
    deedHash: result.deedHash,
    deltas: result.deltas ? plain(result.deltas) : null,
    tier,
    paid: { amount: paid.amount, asset: 'HBAR', transaction: paid.settlement, network: paid.network, payer: paid.payer },
    audit: auditOut,
  });
});

/**
 * JSON has no bigint, so amounts arrive as decimal strings. Convert the fields
 * the engine compares numerically. Anything left as a string would silently
 * fail every comparison and produce a clean PASS on a transaction nobody
 * checked, which is the worst possible failure for this service.
 */
function reviveBig(o) {
  const out = { ...o };
  for (const k of ['amount', 'value', 'minOut', 'chainId']) {
    if (out[k] !== undefined && out[k] !== null && typeof out[k] !== 'bigint') {
      out[k] = k === 'chainId' ? Number(out[k]) : BigInt(out[k]);
    }
  }
  return out;
}

app.listen(PORT, () => {
  console.log(`speculum paid check service`);
  console.log(`  listening    http://localhost:${PORT}`);
  console.log(`  paid to      ${PAY_TO}`);
  console.log(`  facilitator  ${FACILITATOR}`);
  console.log(`  simulation   ${RPC ? 'available' : 'off, set RPC_URL to enable the simulated tier'}`);
  console.log(`  audit        ${audit ? `HCS topic ${audit.topicId}` : 'off, set HEDERA_OPERATOR_ID, HEDERA_OPERATOR_KEY and HEDERA_TOPIC_ID'}`);
});
