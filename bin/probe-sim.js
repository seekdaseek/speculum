#!/usr/bin/env node
// speculum — simulation probe
//
// The simulation layer was built and tested against a scripted RPC. This runs
// the real thing: verifyEffect, through the jsonRpc transport, against a live
// node on mainnet state. It prints what came back, not what was expected.
//
//   node bin/probe-sim.js [url] [from]
//
// Two cases share one transaction, 100 USDC to the burn address. The first
// declares 100 and should pass on the balance delta. The second declares 50
// and should block, because the chain moves twice what was declared.
//
// `from` must hold USDC on mainnet. eth_simulateV1 runs with validation off,
// so the node executes the call from that address without a signature, but
// the balance is real: if it is short, transfer() reverts and the probe
// measures a revert rather than a delta. Nothing is signed, nothing is sent.

import { encodeFunctionData, decodeAbiParameters, parseAbi, getAddress, formatUnits } from 'viem';
import { verifyEffect, jsonRpc } from '../src/simulate.js';
import { ABI } from '../src/decode.js';

const URL = process.argv[2] ?? 'https://ethereum-rpc.publicnode.com';
// Circle's mainnet EOA. Checked on Sep 7 2026: no code, ~52.9M USDC.
const FROM = getAddress(process.argv[3] ?? '0x55FE002aefF02F77364de339a1292923A15844B8');
const USDC = getAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
const TO = getAddress('0x000000000000000000000000000000000000dEaD');
const AMOUNT = 100_000000n;

const ERC20 = parseAbi(['function balanceOf(address owner) view returns (uint256)']);

async function call(method, params) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.json();
}

// The transport is the project's own. The fetch handed to it is teed so the
// raw response is visible, not only the result the parser kept.
let raw = null;
const rpc = jsonRpc(URL, async (url, init) => {
  const res = await fetch(url, init);
  const text = await res.text();
  raw = { httpStatus: res.status, bytes: text.length, text };
  return new Response(text, { status: res.status, headers: { 'content-type': 'application/json' } });
});

const shape = (v) =>
  Array.isArray(v) ? (v.length ? `[${v.length} × ${shape(v[0])}]` : '[]')
  : v && typeof v === 'object' ? `{ ${Object.keys(v).join(', ')} }`
  : typeof v;

const dec = (hex) => (hex == null ? 'absent' : String(BigInt(hex)));
const usdc = (n) => `${formatUnits(n, 6)} USDC`;

console.log(`speculum simulation probe\n${'='.repeat(60)}`);
console.log(`endpoint  ${URL}`);

const chain = await call('eth_chainId', []);
if (!chain.result) {
  console.log(`unreachable or no chainId: ${JSON.stringify(chain).slice(0, 200)}`);
  process.exit(1);
}
console.log(`chainId   ${parseInt(chain.result, 16)}`);

const bal = await call('eth_call', [
  { to: USDC, data: encodeFunctionData({ abi: ERC20, functionName: 'balanceOf', args: [FROM] }) },
  'latest',
]);
const balance = bal.result ? decodeAbiParameters([{ type: 'uint256' }], bal.result)[0] : null;
console.log(`from      ${FROM}  holds ${balance == null ? 'unreadable' : usdc(balance)}`);

const tx = {
  to: USDC,
  data: encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [TO, AMOUNT] }),
  value: 0n,
  chainId: 1,
};
console.log(`tx        USDC.transfer(${TO}, ${usdc(AMOUNT)})`);

const cases = [
  { name: `declared ${usdc(AMOUNT)}, calldata moves ${usdc(AMOUNT)}`, amount: AMOUNT, expect: 'PASS' },
  { name: `declared ${usdc(AMOUNT / 2n)}, calldata moves ${usdc(AMOUNT)}`, amount: AMOUNT / 2n, expect: 'BLOCK' },
];

const summary = [];
for (const c of cases) {
  console.log(`\n${'-'.repeat(60)}\n${c.name}`);
  const intent = { action: 'transfer', chainId: 1, token: USDC, amount: c.amount, recipient: TO };

  raw = null;
  const t0 = performance.now();
  const r = await verifyEffect(intent, tx, rpc, { from: FROM });
  const ms = Math.round(performance.now() - t0);

  console.log(`  verdict   ${r.level}   (expected ${c.expect})`);
  for (const f of r.findings) console.log(`  finding   ${f.code}  ${f.detail ?? ''}`);
  if (r.deltas) for (const [t, d] of Object.entries(r.deltas)) console.log(`  delta     ${t}  ${d === null ? 'unreadable' : d}`);
  console.log(`  latency   ${ms} ms wall clock, one eth_simulateV1 round trip`);

  if (!raw) {
    console.log('  raw       no response captured');
  } else {
    console.log(`  http      ${raw.httpStatus}, ${raw.bytes} bytes`);
    let body;
    try { body = JSON.parse(raw.text); } catch { body = null; }
    if (!body) {
      console.log(`  raw       not JSON: ${raw.text.slice(0, 200)}`);
    } else if (body.error) {
      console.log(`  raw       error ${JSON.stringify(body.error)}`);
    } else {
      const block = body.result?.[0];
      console.log(`  shape     ${shape(body)}`);
      console.log(`            result: ${shape(body.result)}`);
      console.log(`            result[0].calls: ${shape(block?.calls)}`);
      console.log(`  block     number ${dec(block?.number)}  gasUsed ${dec(block?.gasUsed)}  baseFee ${dec(block?.baseFeePerGas)}`);
      (block?.calls ?? []).forEach((k, i) => {
        const what = i === 0 ? 'balanceOf before' : i === 1 ? 'transfer' : 'balanceOf after';
        console.log(`  call[${i}]   ${what.padEnd(16)} status ${k.status}  gasUsed ${dec(k.gasUsed)}  logs ${k.logs?.length ?? 'absent'}  returnData ${String(k.returnData).slice(0, 18)}…`);
      });
    }
  }

  summary.push({ ...c, level: r.level, ms, codes: r.findings.map((f) => f.code) });
}

console.log(`\n${'='.repeat(60)}`);
for (const s of summary) {
  console.log(`${s.level === s.expect ? 'as expected' : 'NOT as expected'}  ${s.name}  ->  ${s.level}${s.codes.length ? ` [${s.codes}]` : ''}  ${s.ms} ms`);
}
process.exit(summary.every((s) => s.level === s.expect) ? 0 : 1);
