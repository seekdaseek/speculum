// speculum — the agent that pays for a check
//
// This is the consumer side. It discovers what the service costs, gets a 402,
// signs a payment, and comes back with proof. No account, no API key, no
// subscription anywhere in the flow.
//
//   HEDERA_ACCOUNT_ID=0.0.x HEDERA_PRIVATE_KEY=0x... node hedera/agent.js
//
// Deliberately does the unpaid request first rather than paying up front. The
// price comes from the server's 402, not from anything hardcoded here, so the
// agent cannot pay the wrong amount by holding a stale price.

import { ExactHederaScheme } from '@x402/hedera/exact/client';
import { createClientHederaSigner, PrivateKey, HEDERA_TESTNET_CAIP2 } from '@x402/hedera';
import { encodeFunctionData } from 'viem';
import { ABI } from '../src/decode.js';

const SERVICE = process.env.SERVICE ?? 'http://localhost:4021';
const ACCOUNT = process.env.HEDERA_ACCOUNT_ID;
const KEY = process.env.HEDERA_PRIVATE_KEY;

if (!ACCOUNT || !KEY) {
  console.error('set HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY (the paying agent, not the service)');
  process.exit(1);
}

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const MINE = '0x22DB3A9686EE5261e7Bf3ed4f91277232E8076e6';
const THEIRS = '0x000000000000000000000000000000000000dEaD';

// What the agent claims, against what it would actually sign. Amounts go over
// the wire as decimal strings because JSON has no bigint.
const request = {
  intent: { action: 'transfer', chainId: 1, token: USDC, amount: '100000000', recipient: MINE },
  tx: {
    to: USDC,
    data: encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [THEIRS, 100_000000n] }),
    value: '0',
    chainId: 1,
  },
};

console.log('1. what does this service do and what does it cost');
const descriptor = await fetch(`${SERVICE}/`).then((r) => r.json());
console.log(`   ${descriptor.service}: ${descriptor.what}`);
for (const t of descriptor.pricing.tiers) {
  console.log(`   ${t.tier.padEnd(10)} ${t.amount.padStart(8)} tinybar   ${t.covers}`);
}

console.log('\n2. ask without paying');
const unpaid = await fetch(`${SERVICE}/check`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(request),
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

console.log('\n3. sign a payment for exactly what was quoted');
const signer = createClientHederaSigner(
  ACCOUNT,
  PrivateKey.fromStringECDSA(KEY),
  { network: HEDERA_TESTNET_CAIP2 },
);
const signed = await new ExactHederaScheme(signer).createPaymentPayload(2, requirements);
const paymentPayload = {
  x402Version: 2,
  scheme: 'exact',
  network: HEDERA_TESTNET_CAIP2,
  accepted: requirements,
  payload: signed.payload,
};
console.log('   signed');

console.log('\n4. ask again, with proof');
const paid = await fetch(`${SERVICE}/check`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'X-PAYMENT': Buffer.from(JSON.stringify(paymentPayload)).toString('base64'),
  },
  body: JSON.stringify(request),
});

const out = await paid.json();
if (!paid.ok) {
  console.error(`   ${paid.status}: ${out.error}${out.reason ? ` — ${out.reason}` : ''}`);
  process.exit(1);
}

console.log(`\n   agent said   sending 100 USDC to ${MINE}`);
console.log(`   calldata     sending 100 USDC to ${THEIRS}`);
console.log(`   verdict      ${out.verdict}${out.irreversible ? '  (irreversible)' : ''}`);
for (const f of out.findings) console.log(`                ${f.code} — ${f.why}`);
console.log(`\n   paid         ${out.paid.amount} tinybar in HBAR`);
console.log(`   settled      ${out.paid.transaction}`);
console.log(`   tier         ${out.tier}`);
console.log(`\n   the agent bought a verdict on its own behaviour, and it was told no.`);
