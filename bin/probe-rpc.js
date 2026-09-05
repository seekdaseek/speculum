#!/usr/bin/env node
// speculum — RPC probe
//
// The simulation layer assumes eth_simulateV1 exists and returns a particular
// shape. That assumption has never been tested against a real node. This finds
// out, one endpoint at a time, and reports exactly which part fails.
//
//   node bin/probe-rpc.js [url ...]
//
// Endpoints are candidates, not recommendations. Support for eth_simulateV1
// varies by client and by provider tier, and a 200 response does not mean the
// method ran.

import { encodeFunctionData, decodeAbiParameters, parseAbi, getAddress } from 'viem';

const USDC = getAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
const ZERO = '0x0000000000000000000000000000000000000000';
const ERC20 = parseAbi(['function balanceOf(address owner) view returns (uint256)']);

const CANDIDATES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'https://eth.llamarpc.com',
      'https://ethereum-rpc.publicnode.com',
      'https://rpc.ankr.com/eth',
      'https://eth.drpc.org',
      'https://cloudflare-eth.com',
    ];

const balanceOf = (who) =>
  encodeFunctionData({ abi: ERC20, functionName: 'balanceOf', args: [who] });

async function rpcCall(url, method, params) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); }
    catch { return { httpStatus: res.status, parseError: text.slice(0, 120) }; }
    return { httpStatus: res.status, ...json };
  } catch (err) {
    return { transportError: String(err.name === 'AbortError' ? 'timed out after 15s' : err.message) };
  } finally {
    clearTimeout(timer);
  }
}

async function probe(url) {
  const line = (s) => console.log(`    ${s}`);
  console.log(`\n${url}`);

  const alive = await rpcCall(url, 'eth_chainId', []);
  if (alive.transportError) return line(`unreachable: ${alive.transportError}`), null;
  if (!alive.result) return line(`no chainId: ${JSON.stringify(alive.error ?? alive).slice(0, 140)}`), null;
  line(`reachable, chainId ${parseInt(alive.result, 16)}`);

  const sim = await rpcCall(url, 'eth_simulateV1', [
    {
      blockStateCalls: [{ calls: [{ to: USDC, data: balanceOf(ZERO) }] }],
      validation: false,
      traceTransfers: true,
    },
    'latest',
  ]);

  if (sim.transportError) return line(`simulate transport error: ${sim.transportError}`), null;
  if (sim.error) {
    line(`eth_simulateV1 REJECTED  code ${sim.error.code}  ${String(sim.error.message).slice(0, 110)}`);
    return { url, chainId: parseInt(alive.result, 16), simulate: false, reason: sim.error.message };
  }

  const calls = sim.result?.[0]?.calls;
  if (!Array.isArray(calls)) {
    line(`unexpected shape, no calls array: ${JSON.stringify(sim.result).slice(0, 160)}`);
    return { url, simulate: false, reason: 'unexpected shape' };
  }

  const c = calls[0];
  let decoded = null;
  try { decoded = decodeAbiParameters([{ type: 'uint256' }], c.returnData)[0]; } catch { /* stays null */ }

  line(`eth_simulateV1 OK  status ${c.status}  returnData ${String(c.returnData).slice(0, 20)}...`);
  line(decoded === null
    ? 'returnData did NOT decode as uint256 — the engine parser would refuse here'
    : `decoded balanceOf(0x0) = ${decoded}`);
  line(`gasUsed field present: ${c.gasUsed !== undefined}`);

  return { url, chainId: parseInt(alive.result, 16), simulate: true, decodes: decoded !== null };
}

console.log('probing eth_simulateV1 support\n' + '='.repeat(50));
const results = [];
for (const url of CANDIDATES) results.push(await probe(url));

const good = results.filter((r) => r && r.simulate && r.decodes);
console.log('\n' + '='.repeat(50));
console.log(good.length
  ? `USABLE: ${good.map((r) => r.url).join('\n         ')}`
  : 'NO ENDPOINT SUPPORTED eth_simulateV1. The simulation layer needs a node that does,\nor it needs rewriting onto eth_call with separate reads, which samples different\nstate and produces deltas that never existed.');
