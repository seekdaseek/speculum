#!/usr/bin/env node
// speculum — which key is this, really
//
// Settlement failed with INVALID_SIGNATURE, which means the signature did not
// match the account being debited. Rather than guess at encodings, this derives
// the public key from the private key under each parse the SDK offers, asks the
// mirror node what public key the account actually holds, and reports which one
// matches.
//
//   HEDERA_ACCOUNT_ID=0.0.x HEDERA_PRIVATE_KEY=0x... node hedera/probe-key.js
//
// Prints public keys only. The private key is never written to output.

import { PrivateKey, HEDERA_TESTNET_MIRROR_NODE_URL } from '@x402/hedera';

const ACCOUNT = process.env.HEDERA_ACCOUNT_ID;
const KEY = process.env.HEDERA_PRIVATE_KEY;

if (!ACCOUNT || !KEY) {
  console.error('set HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY');
  process.exit(1);
}

console.log(`account   ${ACCOUNT}`);
console.log(`key       ${KEY.length} chars, ${KEY.startsWith('0x') ? 'has' : 'no'} 0x prefix\n`);

const parses = [
  ['fromStringECDSA', (k) => PrivateKey.fromStringECDSA(k)],
  ['fromStringED25519', (k) => PrivateKey.fromStringED25519(k)],
  ['fromStringDer', (k) => PrivateKey.fromStringDer(k)],
];

const derived = [];
for (const [name, fn] of parses) {
  for (const variant of [KEY, KEY.replace(/^0x/, '')]) {
    try {
      const pk = fn(variant);
      const pub = pk.publicKey.toStringRaw();
      const label = `${name}${variant === KEY ? '' : ' (0x stripped)'}`;
      derived.push({ label, pub, der: pk.publicKey.toStringDer() });
      console.log(`${label.padEnd(34)} public ${pub}`);
    } catch (err) {
      const label = `${name}${variant === KEY ? '' : ' (0x stripped)'}`;
      console.log(`${label.padEnd(34)} does not parse — ${String(err.message).slice(0, 60)}`);
    }
  }
}

console.log(`\nasking the mirror node what ${ACCOUNT} actually holds`);
const url = `${HEDERA_TESTNET_MIRROR_NODE_URL}/api/v1/accounts/${ACCOUNT}`;
const res = await fetch(url);
if (!res.ok) {
  console.error(`mirror node returned ${res.status} for ${ACCOUNT}`);
  process.exit(1);
}
const acct = await res.json();
const onChain = acct.key?.key ?? null;
const keyType = acct.key?._type ?? 'unknown';

console.log(`  type    ${keyType}`);
console.log(`  key     ${onChain}`);
console.log(`  balance ${acct.balance?.balance ?? '?'} tinybar`);
console.log(`  evm     ${acct.evm_address ?? 'none'}`);

const match = derived.find(
  (d) =>
    onChain &&
    (d.pub.toLowerCase() === onChain.toLowerCase() ||
      d.der.toLowerCase() === onChain.toLowerCase() ||
      d.pub.toLowerCase().endsWith(onChain.toLowerCase()) ||
      onChain.toLowerCase().endsWith(d.pub.toLowerCase())),
);

console.log('');
if (match) {
  console.log(`MATCH: parse this key with ${match.label}`);
  process.exit(0);
}
console.log('NO MATCH under any parse.');
console.log('That means this private key does not control this account, so no encoding');
console.log('change will fix it. Check that the account id and the key came from the');
console.log('same row of the portal.');
process.exit(1);
