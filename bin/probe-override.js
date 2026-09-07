#!/usr/bin/env node
// speculum — exercise the signed override on a live EVM, before deploying it
//
// The contract's recovery has to agree byte for byte with the message the
// device signs, and the only EVM that counts is a real one. This places the
// compiled runtime code at an address through an eth_call state override on a
// public Base Sepolia node and calls it there. Nothing is deployed, nothing
// is signed by any key that matters: the approver here is a throwaway
// account, so the signature is real secp256k1 and the recovery is real.
//
//   node bin/compile.js && node bin/probe-override.js
//
// Also measures what the deploy will cost, from the deployer's own address,
// so nobody discovers an unfunded key at deploy time.

import { readFileSync } from 'fs';
import { encodeFunctionData, decodeFunctionResult, keccak256, toHex, recoverMessageAddress } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { LedgerPort } from '../src/gate.js';

const RPC = process.env.RPC_URL ?? 'https://sepolia.base.org';
const DEPLOYER = process.env.DEPLOYER ?? '0xC50D7Cfd53542C9266A71E499548674c006354f6';
const AT = '0x1000000000000000000000000000000000000001';

const art = JSON.parse(readFileSync('artifacts/Speculum.json', 'utf8'));
if (!art.deployedBytecode) { console.error('artifact has no deployedBytecode; run node bin/compile.js'); process.exit(1); }

const rpc = async (method, params) => {
  const j = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (j.error) throw new Error(j.error.message ?? JSON.stringify(j.error));
  return j.result;
};
const override = { [AT]: { code: art.deployedBytecode } };
const view = async (fn, args) => decodeFunctionResult({ abi: art.abi, functionName: fn,
  data: await rpc('eth_call', [{ to: AT, data: encodeFunctionData({ abi: art.abi, functionName: fn, args }) }, 'latest', override]) });
const gas = async (fn, args) => parseInt(await rpc('eth_estimateGas', [{ from: DEPLOYER, to: AT, data: encodeFunctionData({ abi: art.abi, functionName: fn, args }) }, 'latest', override]), 16);
const reverts = async (fn, args) => { try { await gas(fn, args); return false; } catch { return true; } };

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`); if (!ok) fails++; };

console.log(`node      ${RPC}`);
console.log(`runtime   ${(art.deployedBytecode.length - 2) / 2} bytes placed at ${AT} by state override\n`);

const deedHash = keccak256(toHex('a deed'));
const reason = 'the funds go to an address other than the declared recipient';
const message = LedgerPort.message({ deedHash, level: 'BLOCK', reason });
check('contract rebuilds the device message byte for byte', (await view('approvalMessage', [deedHash, 1, reason])) === message, `${message.length} chars`);

const approver = privateKeyToAccount(generatePrivateKey());
const sig = await approver.signMessage({ message });
const recovered = await view('recoverApprover', [deedHash, 1, reason, sig]);
check('contract recovers the approver', recovered === approver.address, recovered);
check('viem recovers the same address', (await recoverMessageAddress({ message, signature: sig })) === recovered);
check('same signature over a different deed recovers someone else', (await view('recoverApprover', [keccak256(toHex('other')), 1, reason, sig])) !== approver.address);
check('same signature with a different reason recovers someone else', (await view('recoverApprover', [deedHash, 1, reason + '.', sig])) !== approver.address);
check('same signature with a different level recovers someone else', (await view('recoverApprover', [deedHash, 2, reason, sig])) !== approver.address);
check('a short signature recovers nobody', (await view('recoverApprover', [deedHash, 1, reason, '0x1234'])) === '0x0000000000000000000000000000000000000000');
check('v as 0/1 is accepted', (await view('recoverApprover', [deedHash, 1, reason, sig.slice(0, -2) + (parseInt(sig.slice(-2), 16) - 27).toString(16).padStart(2, '0')])) === approver.address);
check('recordOverride with a valid signature does not revert', !(await reverts('recordOverride', [deedHash, 1, reason, sig])));
check('recordOverride with no signature reverts', await reverts('recordOverride', [deedHash, 1, reason, '0x']));
check('recordOverride on a PASS reverts', await reverts('recordOverride', [deedHash, 0, reason, sig]));
check('record still holds level-contradicts-findings', await reverts('record', [deedHash, deedHash, 0, 1, DEPLOYER]));

console.log('\ngas, measured by eth_estimateGas on this node:');
const deployGas = parseInt(await rpc('eth_estimateGas', [{ from: DEPLOYER, data: art.bytecode }]), 16);
console.log(`  deploy                      ${deployGas}`);
console.log(`  record                      ${await gas('record', [deedHash, deedHash, 1, 4, DEPLOYER])}`);
console.log(`  declareIntent               ${await gas('declareIntent', [deedHash])}`);
console.log(`  recordOverride (signed)     ${await gas('recordOverride', [deedHash, 1, reason, sig])}`);

const price = BigInt(await rpc('eth_gasPrice', []));
const balance = BigInt(await rpc('eth_getBalance', [DEPLOYER, 'latest']));
const cost = BigInt(deployGas) * price;
console.log(`\ndeployer  ${DEPLOYER}`);
console.log(`balance   ${balance} wei (${Number(balance) / 1e18} ETH)`);
console.log(`gas price ${price} wei`);
console.log(`deploy    ≈ ${cost} wei (${Number(cost) / 1e18} ETH) for execution; Base adds an L1 data fee on top, small at this size`);
check('balance covers the deploy with a 100x margin', balance > cost * 100n, `${(Number(balance) / Number(cost)).toFixed(0)}x`);

console.log(fails ? `\n${fails} FAILED` : '\nall held');
process.exit(fails ? 1 : 0);
