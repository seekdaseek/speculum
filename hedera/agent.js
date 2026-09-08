// speculum — the agent that pays for a check
//
// This is the consumer side. It discovers what the service costs, gets a 402,
// signs a payment, comes back with proof, and acts on what it is told. No
// account, no API key, no subscription anywhere in the flow.
//
//   HEDERA_ACCOUNT_ID=0.0.x HEDERA_PRIVATE_KEY=0x... node hedera/agent.js
//   CASE=honest|divergent|both   which checks to buy, default both
//
// Two checks by default, each paid for separately. The honest one approves
// exactly what it declared. The divergent one declares an exact amount and
// approves without bound, which is the failure this project was built around:
// nothing reverts, nothing looks malicious, and the allowance is unlimited.
// The agent pays to be told, and does not sign what it was told to block.
//
// The unpaid request comes first, deliberately. The price comes from the
// server's 402, not from anything hardcoded here, so the agent cannot pay the
// wrong amount by holding a stale price.

import { ExactHederaScheme } from '@x402/hedera/exact/client';
import { createClientHederaSigner, PrivateKey, HEDERA_TESTNET_CAIP2 } from '@x402/hedera';
import { encodeFunctionData } from 'viem';
import { ABI, MAX_UINT256 } from '../src/decode.js';

const SERVICE = process.env.SERVICE ?? 'http://localhost:4021';
const ACCOUNT = process.env.HEDERA_ACCOUNT_ID;
const KEY = process.env.HEDERA_PRIVATE_KEY;
const CASE = process.env.CASE ?? 'both';

if (!ACCOUNT || !KEY) {
  console.error('set HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY (the paying agent, not the service)');
  process.exit(1);
}

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
const EXACT = 100_000000n; // 100 USDC

const approve = (amount) => ({
  to: USDC,
  data: encodeFunctionData({ abi: ABI, functionName: 'approve', args: [ROUTER, amount] }),
  value: '0',
  chainId: 1,
});

// What the agent claims, against what it would actually sign. Amounts go over
// the wire as decimal strings because JSON has no bigint.
const CASES = {
  honest: {
    said: `approve exactly 100 USDC to the router`,
    does: `approve exactly 100 USDC to the router`,
    expect: 'match',
    request: {
      intent: { action: 'approve', chainId: 1, token: USDC, amount: EXACT.toString(), spender: ROUTER },
      tx: approve(EXACT),
    },
  },
  divergent: {
    said: `approve exactly 100 USDC to the router`,
    does: `approve an UNLIMITED amount of USDC to the router`,
    expect: 'divergence',
    request: {
      intent: { action: 'approve', chainId: 1, token: USDC, amount: EXACT.toString(), spender: ROUTER },
      tx: approve(MAX_UINT256),
    },
  },
};

const wanted = CASE === 'both' ? ['honest', 'divergent'] : [CASE];
if (wanted.some((c) => !CASES[c])) {
  console.error(`CASE must be honest, divergent or both`);
  process.exit(1);
}

const signer = createClientHederaSigner(ACCOUNT, PrivateKey.fromStringECDSA(KEY), { network: HEDERA_TESTNET_CAIP2 });
const scheme = new ExactHederaScheme(signer);

console.log('what does this service do and what does it cost');
const descriptor = await fetch(`${SERVICE}/`).then((r) => r.json());
console.log(`   ${descriptor.service}: ${descriptor.what}`);
for (const t of descriptor.pricing.tiers) {
  console.log(`   ${t.tier.padEnd(10)} ${t.amount.padStart(8)} tinybar   ${t.covers}`);
}
console.log(`   audit      ${descriptor.audit?.hcs ? `HCS topic ${descriptor.audit.topic}` : 'off'}`);

const receipts = [];

for (const name of wanted) {
  const c = CASES[name];
  console.log(`\n${'═'.repeat(64)}\n${name.toUpperCase()}: the agent says it will ${c.said}\n${' '.repeat(name.length + 2)}the calldata would ${c.does}`);

  console.log('\n1. ask without paying');
  const unpaid = await fetch(`${SERVICE}/check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(c.request),
  });
  if (unpaid.status !== 402) {
    const detail = await unpaid.text();
    if (unpaid.status === 503) {
      // The service refuses to quote a price it cannot honour. That is the
      // correct behaviour, not a bug: quoting a stale or invented fee payer
      // produces a payload that signs locally and fails at settlement.
      console.error(`   503 — the service could not reach the facilitator, so it declined to quote.`);
      console.error(`   ${detail}`);
    } else {
      console.error(`   expected 402, got ${unpaid.status}. the service is not gated.`);
      console.error(`   ${detail.slice(0, 200)}`);
    }
    process.exit(1);
  }
  const quote = await unpaid.json();
  const requirements = quote.accepts[0];
  console.log(`   402, as it should be`);
  console.log(`   price      ${requirements.amount} tinybar to ${requirements.payTo}`);
  console.log(`   fee payer  ${requirements.extra.feePayer}  (the facilitator co-signs)`);

  console.log('\n2. sign a payment for exactly what was quoted');
  const signed = await scheme.createPaymentPayload(2, requirements);
  const paymentPayload = {
    x402Version: 2,
    scheme: 'exact',
    network: HEDERA_TESTNET_CAIP2,
    accepted: requirements,
    payload: signed.payload,
  };
  console.log('   signed');

  console.log('\n3. ask again, with proof');
  const paid = await fetch(`${SERVICE}/check`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-PAYMENT': Buffer.from(JSON.stringify(paymentPayload)).toString('base64'),
    },
    body: JSON.stringify(c.request),
  });

  const out = await paid.json();
  if (!paid.ok) {
    // A settlement error is reported as the facilitator worded it, and the
    // run stops. Nothing here retries a payment or invents a reference.
    console.error(`   ${paid.status}: ${out.error}${out.reason ? ` — ${out.reason}` : ''}`);
    process.exit(1);
  }

  console.log(`\n   verdict      ${out.verdict}  (${out.outcome})${out.irreversible ? '  irreversible' : ''}`);
  for (const f of out.findings) console.log(`                ${f.code} — ${f.why}`);
  console.log(`   effects      ${out.effects.action} ${out.effects.amount} of ${out.effects.asset} to spender ${out.effects.spender}`);
  console.log(`\n   paid         ${out.paid.amount} tinybar in HBAR, tier ${out.tier}`);
  console.log(`   settled      ${out.paid.transaction}  on ${out.paid.network}`);
  if (out.audit?.sequenceNumber) {
    console.log(`   audited      HCS ${out.audit.topicId} #${out.audit.sequenceNumber}`);
    console.log(`                ${out.audit.verify}`);
  } else if (out.audit?.error) {
    console.log(`   audit        FAILED: ${out.audit.error}`);
  } else {
    console.log(`   audit        off on this service`);
  }

  // 4. act on it. The agent holds no EVM key here, so acting means deciding.
  // On a match it would go on to sign; on anything else it stops, and says
  // which it did rather than leaving the reader to infer it.
  const act = out.outcome === 'match'
    ? 'the agent proceeds to sign this transaction'
    : out.outcome === 'divergence'
      ? 'the agent refuses to sign: the bytes do not do what it said'
      : 'the agent refuses to sign: the effect could not be determined';
  console.log(`\n4. ${act}`);
  console.log(`   expected ${c.expect}, got ${out.outcome}${out.outcome === c.expect ? '' : '  <-- NOT AS EXPECTED'}`);

  receipts.push({ name, outcome: out.outcome, expected: c.expect, settlement: out.paid.transaction, audit: out.audit });
}

console.log(`\n${'═'.repeat(64)}\nsettlements observed`);
for (const r of receipts) {
  console.log(`   ${r.name.padEnd(10)} ${r.outcome.padEnd(15)} ${r.settlement}${r.audit?.sequenceNumber ? `   HCS #${r.audit.sequenceNumber}` : ''}`);
}
const allAsExpected = receipts.every((r) => r.outcome === r.expected);
console.log(allAsExpected
  ? '\n   the agent bought verdicts on its own behaviour, and was told no exactly when it should have been.'
  : '\n   at least one verdict was not what the case expected. read the findings above.');
process.exit(allAsExpected ? 0 : 1);
