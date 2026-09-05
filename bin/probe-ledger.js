#!/usr/bin/env node
// speculum — Ledger probe
//
// Settles what the device actually does, rather than what the code assumes.
// Three questions, in order of how badly a wrong answer would hurt:
//
//   1. Does signPersonalMessage work headlessly, or does it need a tap?
//      The whole design rests on a tap being required for irreversible actions.
//      If it signs silently, the human-in-the-loop claim is false.
//   2. What does a decline look like? The port matches on 0x6985 and on the
//      words denied or rejected. If the real error is something else, a
//      decline would be misreported as a device fault.
//   3. Does the approval message fit on the screen, or is it truncated?
//      A human approving a message they cannot fully read is the same failure
//      speculum exists to catch.
//
// Requires: device plugged in, unlocked, Ethereum app open.
//   npm i @ledgerhq/hw-app-eth @ledgerhq/hw-transport-node-hid
//   node bin/probe-ledger.js

import { createRequire } from 'module';
import { LedgerPort } from '../src/gate.js';

// Ledger's packages must be loaded through require, not import.
//
// Their lib-es build contains extensionless relative imports, which Node's ESM
// resolver rejects outright: importing @ledgerhq/hw-transport-node-hid fails on
// a nested @ledgerhq/errors path that does not resolve. The CJS build has no
// such problem. Verified both ways before writing this: ESM throws
// ERR_MODULE_NOT_FOUND, require returns the constructors.
const require = createRequire(import.meta.url);

const DEED = '0x' + 'ab'.repeat(32);
const PATH = "44'/60'/0'/0/0";

let TransportNodeHid, Eth;
try {
  const t = require('@ledgerhq/hw-transport-node-hid');
  const e = require('@ledgerhq/hw-app-eth');
  TransportNodeHid = t.default ?? t;
  Eth = e.default ?? e;
} catch (err) {
  console.error('missing packages. run:\n  npm i @ledgerhq/hw-app-eth @ledgerhq/hw-transport-node-hid\n');
  console.error(String(err.message));
  process.exit(1);
}

const message = LedgerPort.message({
  deedHash: DEED,
  level: 'BLOCK',
  reason: 'the funds go to an address other than the declared recipient',
});

console.log('approval message that will be shown:\n');
console.log(message.split('\n').map((l) => '  | ' + l).join('\n'));
console.log(`\n  ${message.length} characters, ${message.split('\n').length} lines\n`);

let transport;
try {
  transport = await TransportNodeHid.create(3000);
} catch (err) {
  console.error('could not open the device:', String(err.message));
  console.error('check: plugged in, unlocked, Ethereum app open, no other app using it (Ledger Live)');
  process.exit(1);
}

const eth = new Eth(transport);

try {
  const t0 = Date.now();
  const { address } = await eth.getAddress(PATH, false);
  console.log(`address at ${PATH}: ${address}   (${Date.now() - t0}ms, no confirmation requested)`);

  console.log('\nrequesting a signature. WATCH THE DEVICE.');
  console.log('if it signs with no prompt, the human-in-the-loop claim is false and must be rewritten.\n');

  const t1 = Date.now();
  const sig = await eth.signPersonalMessage(PATH, Buffer.from(message, 'utf8').toString('hex'));
  const ms = Date.now() - t1;

  console.log(`signed in ${ms}ms`);
  console.log(`  v ${sig.v}  r ${String(sig.r).slice(0, 18)}...  s ${String(sig.s).slice(0, 18)}...`);
  console.log(ms < 400
    ? '\n  WARNING: signed too fast for a human tap. Verify whether the device prompted at all.'
    : '\n  consistent with a human confirmation.');
  console.log('\nreport: did the device show the deed hash in full, or truncate it?');
} catch (err) {
  const msg = String(err.message ?? err);
  const statusText = err.statusCode ? ` statusCode 0x${err.statusCode.toString(16)}` : '';
  console.log(`\nsignature did not complete:${statusText}\n  ${msg}`);
  console.log(`  the port classifies this as: ${LedgerPort.classify(err)}`);
  console.log('  if you pressed reject and this does not say "declined on device", the matcher is wrong.');
} finally {
  await transport.close();
}
