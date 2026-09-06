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
// The service never holds a key. It quotes a price, hands the payment payload
// to the facilitator to verify and settle, and only then does the work.

import express from 'express';
import { Gate } from '../src/gate.js';
import { jsonRpc } from '../src/simulate.js';
import { HBAR_ASSET_ID, HEDERA_TESTNET_CAIP2 } from '@x402/hedera';

const FACILITATOR = process.env.FACILITATOR ?? 'https://api.testnet.blocky402.com';
const PAY_TO = process.env.HEDERA_ACCOUNT_ID;
const PORT = Number(process.env.PORT ?? 4021);
const RPC = process.env.RPC_URL ?? null;

if (!PAY_TO) {
  console.error('set HEDERA_ACCOUNT_ID to the account that receives payment, e.g. 0.0.12345');
  process.exit(1);
}

// Tinybars. 100,000,000 tinybars = 1 HBAR.
export const PRICES = {
  decode: 100_000n,      // 0.001 HBAR — decode and compare, no network
  simulated: 500_000n,   // 0.005 HBAR — adds an eth_simulateV1 round trip
};

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
    source: 'https://github.com/seekdaseek/speculum',
  });
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

  // Paid. Now do the work.
  const gate = new Gate({ rpc: wantsSimulation ? jsonRpc(RPC) : null });

  let result;
  try {
    result = await gate.check(reviveBig(intent), reviveBig(tx), { from });
  } catch (err) {
    // The payment already settled, so say plainly that the work failed rather
    // than returning a verdict nobody computed.
    return res.status(500).json({
      error: 'check failed after payment settled',
      reason: String(err.message),
      settlement: settle.transaction,
    });
  }

  res.set('X-PAYMENT-RESPONSE', Buffer.from(JSON.stringify({
    success: true, transaction: settle.transaction, network: settle.network,
  })).toString('base64'));

  res.json({
    verdict: result.level,
    irreversible: result.irreversible,
    needsHuman: result.needsHuman,
    findings: result.findings.map((f) => ({ code: f.code, why: f.why, detail: f.detail ?? null })),
    intentHash: result.intentHash,
    deedHash: result.deedHash,
    deltas: result.deltas
      ? Object.fromEntries(Object.entries(result.deltas).map(([k, v]) => [k, v === null ? null : v.toString()]))
      : null,
    tier,
    paid: { amount: requirements.amount, asset: 'HBAR', transaction: settle.transaction, payer: verify.payer ?? null },
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
});
