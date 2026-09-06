#!/usr/bin/env node
// speculum — end to end
//
// Runs real intents and real calldata through the gate and writes each verdict
// on chain, which is what fills the subgraph. Nothing here is mocked: the
// calldata is encoded with viem, the comparison is the same engine the tests
// exercise, and the transactions are sent to the deployed contract.
//
//   RPC_URL=https://sepolia.base.org DEPLOY_KEY=$(cat .deploykey) node bin/demo.js
//
// Add --ledger to route every blocked verdict through a physical confirmation
// before it is recorded. That is slower and needs the device, but it is the
// whole point of the design, so it is worth watching once.

import { readFileSync } from 'fs';
import { createWalletClient, createPublicClient, http, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createRequire } from 'module';
import { Gate, LedgerPort } from '../src/gate.js';
import { ABI } from '../src/decode.js';
import { hashIntent } from '../src/onchain.js';
import { Level } from '../src/types.js';

const CONTRACT = '0xb71db47937d8ddbe1fff208cf5da2727c3f90d9b';

const RPC = process.env.RPC_URL;
const KEY = process.env.DEPLOY_KEY;
const useLedger = process.argv.includes('--ledger');

if (!RPC || !KEY) { console.error('set RPC_URL and DEPLOY_KEY'); process.exit(1); }

const artifact = JSON.parse(readFileSync('artifacts/Speculum.json', 'utf8'));
const account = privateKeyToAccount(KEY);
const pub = createPublicClient({ transport: http(RPC) });
const wallet = createWalletClient({ account, transport: http(RPC) });

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const MINE = account.address;
const THEIRS = '0x000000000000000000000000000000000000dEaD';
const ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
const MAX = (1n << 256n) - 1n;
const call = (n, a) => encodeFunctionData({ abi: ABI, functionName: n, args: a });

// Each case is a thing an agent could plausibly say, paired with what it would
// actually sign. The first is honest. The rest are the failure modes.
const CASES = [
  {
    name: 'honest transfer',
    said: 'sending 100 USDC to 0x…dEaD',
    intent: { action: 'transfer', chainId: 1, token: USDC, amount: 100_000000n, recipient: THEIRS },
    tx: { to: USDC, data: call('transfer', [THEIRS, 100_000000n]), value: 0n, chainId: 1 },
  },
  {
    // Byte-identical calldata to the case above. Only the declaration differs,
    // so the deed hash is the same and the verdicts are opposite. That is the
    // whole thesis in two lines: the bytes are not honest or dishonest on
    // their own, only against what was claimed about them.
    name: 'recipient swapped (same bytes as above)',
    said: 'sending 100 USDC to my own address',
    intent: { action: 'transfer', chainId: 1, token: USDC, amount: 100_000000n, recipient: MINE },
    tx: { to: USDC, data: call('transfer', [THEIRS, 100_000000n]), value: 0n, chainId: 1 },
  },
  {
    name: 'approval came out unlimited',
    said: 'approving exactly 100 USDC to the router',
    intent: { action: 'approve', chainId: 1, token: USDC, amount: 100_000000n, spender: ROUTER },
    tx: { to: USDC, data: call('approve', [ROUTER, MAX]), value: 0n, chainId: 1 },
  },
  {
    name: 'says swap, grants collection-wide approval',
    said: 'swapping 100 USDC for WETH',
    intent: { action: 'swap', chainId: 1, token: USDC, amount: 100_000000n, recipient: MINE },
    tx: { to: WETH, data: call('setApprovalForAll', [THEIRS, true]), value: 0n, chainId: 1 },
  },
  {
    name: 'swap output routed elsewhere',
    said: 'swapping 1000 USDC for WETH, to me',
    intent: { action: 'swap', chainId: 1, token: USDC, amount: 1000_000000n, recipient: MINE },
    tx: {
      to: ROUTER,
      data: call('exactInputSingle', [{
        tokenIn: USDC, tokenOut: WETH, fee: 500, recipient: THEIRS,
        amountIn: 1000_000000n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
      }]),
      value: 0n, chainId: 1,
    },
  },
  {
    name: 'function cannot be identified',
    said: 'sending 5 USDC',
    intent: { action: 'transfer', chainId: 1, token: USDC, amount: 5_000000n, recipient: THEIRS },
    tx: { to: USDC, data: '0xdeadbeef', value: 0n, chainId: 1 },
  },
];

let confirm = null;
if (useLedger) {
  const require = createRequire(import.meta.url);
  const T = require('@ledgerhq/hw-transport-node-hid');
  const E = require('@ledgerhq/hw-app-eth');
  const transport = await (T.default ?? T).create(5000);
  confirm = new LedgerPort({ transport, eth: new (E.default ?? E)(transport) });
  console.log('ledger attached, blocked verdicts will need a physical confirmation\n');
}

const gate = new Gate({ confirm });

const send = async (fn, args) => {
  const hash = await wallet.writeContract({
    address: CONTRACT, abi: artifact.abi, functionName: fn, args, chain: null,
  });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${fn} reverted`);
  return { hash, gas: r.gasUsed };
};

console.log(`agent    ${MINE}`);
console.log(`contract ${CONTRACT}`);
console.log(`chain    ${await pub.getChainId()}\n`);

let totalGas = 0n;

for (const c of CASES) {
  console.log('─'.repeat(72));
  console.log(`${c.name}`);
  console.log(`  agent says   ${c.said}`);

  // Declared BEFORE the calldata is judged, so the ordering is on chain and
  // not a claim made afterwards.
  const dec = await send('declareIntent', [hashIntent(c.intent)]);
  totalGas += dec.gas;

  const result = await gate.check(c.intent, c.tx);
  console.log(`  verdict      ${result.level}${result.irreversible ? '  (irreversible)' : ''}`);
  for (const f of result.findings) console.log(`               ${f.code} — ${f.why}`);

  // The verdict is recorded BEFORE any human is asked.
  //
  // The first version did the opposite, and it produced a wrong record: an
  // override indexed before its own verdict resolved against whichever check
  // had last touched that deed hash, which linked one approval to an unrelated
  // PASS. Recording the verdict first is also the honest order in the real
  // flow. A human is asked about a judgement that already exists.
  const rec = gate.toRecord(result);
  const r = await send('record', [rec.intentHash, rec.deedHash, rec.level, rec.findings, rec.target]);
  totalGas += r.gas;
  console.log(`  recorded     ${r.hash}  (${r.gas} gas)`);

  if (result.needsHuman && confirm) {
    console.log('  escalating to the device, confirm or reject it');
    const approved = await gate.escalate(result);
    console.log(`  human        ${approved ? 'approved' : confirm.lastError ?? 'declined'}`);
    if (approved) {
      const o = await send('recordOverride', [result.deedHash]);
      totalGas += o.gas;
      console.log(`  override     ${o.hash}  (${o.gas} gas)`);
    }
  } else if (result.needsHuman) {
    console.log('  needs a human — run with --ledger to require the tap');
  }
}

console.log('─'.repeat(72));
console.log(`\n${CASES.length} cases, ${totalGas} gas total\n`);
console.log('query the subgraph:');
console.log(`
curl -s https://api.studio.thegraph.com/query/1758736/speculum/v0.0.2 \\
  -H 'content-type: application/json' \\
  -d '{"query":"{ agents { id checks passed blocked refused divergenceRate } findingCounts(orderBy: count, orderDirection: desc) { id count } }"}' | python3 -m json.tool
`);
