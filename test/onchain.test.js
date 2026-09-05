// speculum — on-chain encoding tests
//
// The bitfield crosses a language boundary, so it is exactly the place a
// silent mismatch would live. These tests pin it down.

import { encodeFunctionData } from 'viem';
import { compare } from '../src/compare.js';
import { Finding, Level, FINDING_LEVEL } from '../src/types.js';
import { ABI } from '../src/decode.js';
import { FINDING_BITS, LEVEL_CODE, encodeFindings, decodeFindings, hashIntent, hashDeed } from '../src/onchain.js';

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const ME = '0x22DB3A9686EE5261e7Bf3ed4f91277232E8076e6';
const THEM = '0x000000000000000000000000000000000000dEaD';
const MAX = (1n << 256n) - 1n;
const call = (n, a) => encodeFunctionData({ abi: ABI, functionName: n, args: a });

let pass = 0, fail = 0;
const out = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  out.push(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `   got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};

// Every finding the engine can emit must have a bit, or a real verdict would
// throw at the moment we tried to record it on-chain.
check('every finding has a bit',
  Object.keys(FINDING_LEVEL).filter((c) => FINDING_BITS[c] === undefined), []);

// Bits must be unique. A collision would merge two classes into one and the
// subgraph would undercount forever.
{
  const bits = Object.values(FINDING_BITS);
  check('bits are unique', bits.length, new Set(bits).size);
}

// The contract emits uint32, so nothing may exceed bit 31.
check('bits fit uint32', Object.values(FINDING_BITS).filter((b) => b > 31), []);

// Round trip.
{
  const codes = [Finding.RECIPIENT_MISMATCH, Finding.UNBOUNDED_APPROVAL];
  const bits = encodeFindings(codes);
  check('round trips', decodeFindings(bits).sort(), codes.slice().sort());
}

// The contract enforces: PASS if and only if findings == 0. If the engine can
// ever produce a clean level with findings attached, every record() call for
// that case reverts. Assert the engine cannot.
{
  const cases = [
    [{ action: 'transfer', chainId: 1, token: USDC, amount: 100n, recipient: THEM },
     { to: USDC, data: call('transfer', [THEM, 100n]), value: 0n, chainId: 1 }],
    [{ action: 'transfer', chainId: 1, token: USDC, amount: 100n, recipient: ME },
     { to: USDC, data: call('transfer', [THEM, 100n]), value: 0n, chainId: 1 }],
    [{ action: 'approve', chainId: 1, token: USDC, amount: 1n, spender: ME },
     { to: USDC, data: call('approve', [ME, MAX]), value: 0n, chainId: 1 }],
    [{ action: 'transfer', chainId: 1, token: USDC, amount: 1n, recipient: ME },
     { to: USDC, data: '0xdeadbeef', value: 0n, chainId: 1 }],
  ];
  let violations = 0;
  for (const [intent, tx] of cases) {
    const r = compare(intent, tx);
    const bits = encodeFindings(r.findings);
    if ((r.level === Level.PASS) !== (bits === 0)) violations++;
  }
  check('engine never contradicts the contract invariant', violations, 0);
}

// Intent hashing must be order independent, or the same declaration would hash
// two ways depending on how the object happened to be built.
{
  const a = { action: 'transfer', chainId: 1, token: USDC, amount: 5n, recipient: ME };
  const b = { recipient: ME, amount: 5n, token: USDC, chainId: 1, action: 'transfer' };
  check('intent hash is key-order independent', hashIntent(a), hashIntent(b));
}

// And it must actually distinguish intents that differ, including by omission.
{
  const base = { action: 'transfer', chainId: 1, token: USDC, amount: 5n, recipient: ME };
  check('different recipient hashes differently',
    hashIntent(base) === hashIntent({ ...base, recipient: THEM }), false);
  check('different amount hashes differently',
    hashIntent(base) === hashIntent({ ...base, amount: 6n }), false);
  check('omitted amount hashes differently',
    hashIntent(base) === hashIntent({ ...base, amount: undefined }), false);
  check('unlimited flag changes the hash',
    hashIntent(base) === hashIntent({ ...base, unlimited: true }), false);
}

// Deed hash must bind the calldata, not just the destination.
{
  const t1 = { chainId: 1, to: USDC, value: 0n, data: call('transfer', [ME, 1n]) };
  const t2 = { chainId: 1, to: USDC, value: 0n, data: call('transfer', [THEM, 1n]) };
  check('deed hash binds calldata', hashDeed(t1) === hashDeed(t2), false);
  check('deed hash binds chain', hashDeed(t1) === hashDeed({ ...t1, chainId: 8453 }), false);
  check('deed hash binds value', hashDeed(t1) === hashDeed({ ...t1, value: 1n }), false);
}

check('level codes match the contract', LEVEL_CODE, { PASS: 0, BLOCK: 1, REFUSE: 2 });

console.log(out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
