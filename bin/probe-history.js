#!/usr/bin/env node
// speculum — run the gate against the live record
//
// Takes the demo's cases, the same intents and the same viem-encoded calldata
// that filled the subgraph, and rules on each one twice: once on the bytes
// alone and once with the deployed subgraph consulted over the network. Prints
// every verdict that history changed, and the latency of every read.
//
//   node bin/probe-history.js
//
// Nothing is signed, sent or recorded. The agent address is read from the
// subgraph itself, because that is where the record is keyed, and no key file
// is opened. Set SUBGRAPH_URL to read a different deployment and
// SUBGRAPH_API_KEY if that deployment needs one; the key is never printed.

import { encodeFunctionData } from 'viem';
import { Gate } from '../src/gate.js';
import { ABI } from '../src/decode.js';
import { subgraphReader } from '../src/history.js';

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const THEIRS = '0x000000000000000000000000000000000000dEaD';
const ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
const MAX = (1n << 256n) - 1n;
const call = (n, a) => encodeFunctionData({ abi: ABI, functionName: n, args: a });

const reader = subgraphReader();
console.log(`subgraph  ${reader.describe()}`);
console.log(`api key   ${reader.usesKey ? 'from env' : 'none, endpoint answers without one'}`);

// The agent whose record we are about to read is the one that wrote it.
const t0 = performance.now();
const who = await reader.query('{ agents(first: 5, orderBy: checks, orderDirection: desc) { id checks passed blocked refused divergenceRate } _meta { block { number } } }');
console.log(`agents    ${who.agents.length} indexed, head block ${who._meta.block.number}, ${Math.round(performance.now() - t0)}ms`);
const MINE = who.agents[0].id;
for (const a of who.agents) console.log(`          ${a.id}  ${a.checks} checks, ${a.blocked} blocked, ${a.refused} refused, rate ${Number(a.divergenceRate).toFixed(3)}`);

const CASES = [
  { name: 'honest transfer (bytes shared with the case below)',
    intent: { action: 'transfer', chainId: 1, token: USDC, amount: 100_000000n, recipient: THEIRS },
    tx: { to: USDC, data: call('transfer', [THEIRS, 100_000000n]), value: 0n, chainId: 1 } },
  { name: 'recipient swapped (same bytes as above)',
    intent: { action: 'transfer', chainId: 1, token: USDC, amount: 100_000000n, recipient: MINE },
    tx: { to: USDC, data: call('transfer', [THEIRS, 100_000000n]), value: 0n, chainId: 1 } },
  { name: 'honest transfer, recipient left undeclared',
    intent: { action: 'transfer', chainId: 1, token: USDC, amount: 100_000000n },
    tx: { to: USDC, data: call('transfer', [THEIRS, 42_000000n]), value: 0n, chainId: 1 } },
  { name: 'honest transfer, fully declared, never seen before',
    intent: { action: 'transfer', chainId: 1, token: USDC, amount: 42_000000n, recipient: THEIRS },
    tx: { to: USDC, data: call('transfer', [THEIRS, 42_000000n]), value: 0n, chainId: 1 } },
  { name: 'exact approval to the router, fully declared',
    intent: { action: 'approve', chainId: 1, token: USDC, amount: 100_000000n, spender: ROUTER },
    tx: { to: USDC, data: call('approve', [ROUTER, 100_000000n]), value: 0n, chainId: 1 } },
  { name: 'approval came out unlimited',
    intent: { action: 'approve', chainId: 1, token: USDC, amount: 100_000000n, spender: ROUTER },
    tx: { to: USDC, data: call('approve', [ROUTER, MAX]), value: 0n, chainId: 1 } },
  { name: 'says swap, grants collection-wide approval',
    intent: { action: 'swap', chainId: 1, token: USDC, amount: 100_000000n, recipient: MINE },
    tx: { to: WETH, data: call('setApprovalForAll', [THEIRS, true]), value: 0n, chainId: 1 } },
  { name: 'function cannot be identified',
    intent: { action: 'transfer', chainId: 1, token: USDC, amount: 5_000000n, recipient: THEIRS },
    tx: { to: USDC, data: '0xdeadbeef', value: 0n, chainId: 1 } },
];

const bare = new Gate();
const withHistory = new Gate({ history: reader });
const latencies = [];
let changed = 0;

for (const c of CASES) {
  console.log('─'.repeat(72));
  console.log(c.name);
  const alone = await bare.check(c.intent, c.tx, { from: MINE });
  const r = await withHistory.check(c.intent, c.tx, { from: MINE });
  latencies.push(r.history.latencyMs);
  const d = r.history.deed;
  console.log(`  bytes alone   ${alone.level}`);
  console.log(`  with history  ${r.verdict}${r.verdict !== alone.level ? '   <- changed' : ''}`);
  if (r.verdict !== alone.level) changed++;
  console.log(`  deed hash     ${r.deedHash}`);
  if (r.history.available) {
    console.log(`  record        ${d.prior} prior verdict(s) on these bytes: ${d.passed} PASS, ${d.blocked} BLOCK, ${d.refused} REFUSE, ${d.overrides} override(s); indexed to block ${r.history.indexedBlock}; ${r.history.latencyMs}ms`);
    const parties = Object.entries(r.history.parties).filter(([, p]) => p.asAgentBlocked || p.asTargetBlocked);
    if (parties.length) console.log(`  parties       ${parties.map(([a, p]) => `${a} agent:${p.asAgentBlocked} target:${p.asTargetBlocked}`).join('; ')}`);
  } else {
    console.log(`  record        unreadable: ${r.history.reason}`);
  }
  for (const f of r.findings) console.log(`  ${f.code.startsWith('HISTORY') ? 'history ' : 'merits  '}      ${f.code}${f.detail ? ` — ${f.detail}` : ''}`);
}

console.log('─'.repeat(72));
const sorted = [...latencies].sort((a, b) => a - b);
console.log(`\n${CASES.length} cases, ${changed} verdict(s) changed by history`);
console.log(`lookup latency  min ${sorted[0]}ms  median ${sorted[Math.floor(sorted.length / 2)]}ms  max ${sorted[sorted.length - 1]}ms  (one round trip each, ${CASES.length} reads)`);
if (latencies.some((l) => l == null)) console.log('some reads did not complete');
process.exit(changed ? 0 : 2);
