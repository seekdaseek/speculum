// speculum — simulation tests
//
// A scripted RPC stands in for a node. It returns balances chosen to produce a
// specific delta, so each case tests the comparison logic rather than a live
// chain. Live-chain runs are a separate step and are not claimed here.

import { encodeAbiParameters, encodeFunctionData, parseAbi, getAddress } from 'viem';
import { verifyEffect, SimFinding } from '../src/simulate.js';
import { Level } from '../src/types.js';

const USDC = getAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
const WETH = getAddress('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
const ME = getAddress('0x22DB3A9686EE5261e7Bf3ed4f91277232E8076e6');
const THEM = getAddress('0x000000000000000000000000000000000000dEaD');

const u256 = (n) => encodeAbiParameters([{ type: 'uint256' }], [n]);
const ERC20 = parseAbi(['function transfer(address to, uint256 amount)']);
const tx = (amount) => ({
  to: USDC,
  data: encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [THEM, amount] }),
  value: 0n,
  chainId: 1,
});

/**
 * Build a fake node.
 * @param before map token -> balance before
 * @param after  map token -> balance after
 */
function fakeRpc(before, after, { reverted = false, broken = false, unreadable = [] } = {}) {
  return {
    async simulate(blocks) {
      if (broken) throw new Error('node unreachable');
      const probes = blocks[0].calls.filter((c) => c.to && !c.value);
      const tokens = [];
      for (const c of blocks[0].calls) {
        if (c.from) break;
        tokens.push(getAddress(c.to));
      }
      const enc = (t, m) =>
        unreadable.includes(t) ? { returnData: '0x', status: '0x1' }
                               : { returnData: u256(m[t] ?? 0n), status: '0x1' };
      return [{
        calls: [
          ...tokens.map((t) => enc(t, before)),
          { status: reverted ? '0x0' : '0x1', returnData: '0x', error: reverted ? { message: 'ERC20: transfer amount exceeds balance' } : undefined },
          ...tokens.map((t) => enc(t, after)),
        ],
      }];
    },
  };
}

let pass = 0, fail = 0;
const out = [];
const check = (n, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  out.push(`${ok ? 'ok  ' : 'FAIL'}  ${n}${ok ? '' : `   got ${got}, want ${want}`}`);
};
const has = (n, r, code) => {
  const ok = r.findings.some((f) => f.code === code);
  ok ? pass++ : fail++;
  out.push(`${ok ? 'ok  ' : 'FAIL'}  ${n}${ok ? '' : `   missing ${code}, got [${r.findings.map(f=>f.code)}]`}`);
};

const intent = { action: 'transfer', chainId: 1, token: USDC, amount: 100n, recipient: THEM };

// --------------------------------------------------- exactly what was declared
{
  const rpc = fakeRpc({ [USDC]: 1000n }, { [USDC]: 900n });
  const r = await verifyEffect(intent, tx(100n), rpc, { from: ME });
  check('honest delta passes', r.level, Level.PASS);
  check('honest delta has no findings', r.findings.length, 0);
  check('delta is reported', r.deltas[USDC], -100n);
}

// ------------------------------------ fee-on-transfer: more leaves than stated
// The calldata argument says 100. The chain moves 105. Decoding alone cannot
// see this; only simulation can.
{
  const rpc = fakeRpc({ [USDC]: 1000n }, { [USDC]: 895n });
  const r = await verifyEffect(intent, tx(100n), rpc, { from: ME });
  check('fee-on-transfer blocks', r.level, Level.BLOCK);
  has('and names the delta', r, SimFinding.BALANCE_DELTA_MISMATCH);
}

// --------------------------------------- a token nobody declared also moves
{
  const rpc = fakeRpc({ [USDC]: 1000n, [WETH]: 5n }, { [USDC]: 900n, [WETH]: 0n });
  const r = await verifyEffect(intent, tx(100n), rpc, { from: ME, watch: [WETH] });
  check('undeclared token movement blocks', r.level, Level.BLOCK);
  has('and names the asset', r, SimFinding.UNDECLARED_ASSET_MOVED);
}

// ------------------------------------------------------------- it reverts
{
  const rpc = fakeRpc({ [USDC]: 1n }, { [USDC]: 1n }, { reverted: true });
  const r = await verifyEffect(intent, tx(100n), rpc, { from: ME });
  check('revert blocks', r.level, Level.BLOCK);
  has('revert named', r, SimFinding.SIMULATION_REVERTED);
  check('revert reason carried', r.findings[0].detail, 'ERC20: transfer amount exceeds balance');
}

// ------------------------------------- the node is down: refuse, never pass
{
  const rpc = fakeRpc({}, {}, { broken: true });
  const r = await verifyEffect(intent, tx(100n), rpc, { from: ME });
  check('unavailable node refuses', r.level, Level.REFUSE);
  has('unavailability named', r, SimFinding.SIMULATION_UNAVAILABLE);
}

// ---------------------- an unreadable balance is not the same as no movement
{
  const rpc = fakeRpc({ [USDC]: 1000n }, { [USDC]: 900n }, { unreadable: [USDC] });
  const r = await verifyEffect(intent, tx(100n), rpc, { from: ME });
  check('unreadable balance refuses rather than passing', r.level, Level.REFUSE);
  check('and is not recorded as a zero delta', r.deltas[USDC], null);
}

// ------------------------------------------ balance going up is not an outflow
{
  const rpc = fakeRpc({ [USDC]: 900n }, { [USDC]: 1000n });
  const r = await verifyEffect(intent, tx(100n), rpc, { from: ME });
  check('incoming balance is not flagged', r.level, Level.PASS);
}

// ------------------------------------------------- tolerance applies as set
{
  const rpc = fakeRpc({ [USDC]: 1000n }, { [USDC]: 899n });
  check('no tolerance by default',
    (await verifyEffect(intent, tx(100n), rpc, { from: ME })).level, Level.BLOCK);
  check('one percent admits it',
    (await verifyEffect(intent, tx(100n), rpc, { from: ME, amountTolerance: 0.01 })).level, Level.PASS);
}

// ------------------------------- a malformed response refuses, never crashes
{
  const rpc = { async simulate() { return [{ calls: [{ status: '0x1' }] }]; } };
  const r = await verifyEffect(intent, tx(100n), rpc, { from: ME });
  check('malformed rpc response refuses', r.level, Level.REFUSE);
}

console.log(out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
