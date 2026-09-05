// speculum — gate tests
//
// The interesting cases here are all about the approval binding. A human
// confirmation that does not commit to specific bytes is worse than none,
// because it manufactures a record of consent for something nobody saw.

import { encodeFunctionData, encodeAbiParameters, parseAbi, getAddress } from 'viem';
import { Gate, LedgerPort } from '../src/gate.js';
import { Level, Finding } from '../src/types.js';
import { ABI } from '../src/decode.js';

const USDC = getAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
const ME = getAddress('0x22DB3A9686EE5261e7Bf3ed4f91277232E8076e6');
const THEM = getAddress('0x000000000000000000000000000000000000dEaD');
const SIGNER = getAddress('0x1111111111111111111111111111111111111111');
const MAX = (1n << 256n) - 1n;

const call = (n, a) => encodeFunctionData({ abi: ABI, functionName: n, args: a });
const u256 = (n) => encodeAbiParameters([{ type: 'uint256' }], [n]);

let pass = 0, fail = 0;
const out = [];
const check = (n, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  out.push(`${ok ? 'ok  ' : 'FAIL'}  ${n}${ok ? '' : `   got ${got}, want ${want}`}`);
};

// A confirmation port that always approves, so the binding logic is what is
// under test rather than the device.
const alwaysApprove = { async request() { return SIGNER; } };
const alwaysDecline = { async request() { return null; } };

const honestTx = { to: USDC, data: call('transfer', [THEM, 100n]), value: 0n, chainId: 1 };
const intent = { action: 'transfer', chainId: 1, token: USDC, amount: 100n, recipient: THEM };

// ------------------------------------------------------- clean run needs nobody
{
  const g = new Gate();
  const r = await g.check(intent, honestTx);
  check('clean check passes', r.level, Level.PASS);
  check('clean check needs no human', r.needsHuman, false);
}

// ----------------------------------------------- divergence demands a human
{
  const g = new Gate({ confirm: alwaysApprove });
  const bad = { to: USDC, data: call('transfer', [SIGNER, 100n]), value: 0n, chainId: 1 };
  const r = await g.check(intent, bad);
  check('divergence blocks', r.level, Level.BLOCK);
  check('divergence needs a human', r.needsHuman, true);
  check('unauthorised before approval', g.authorise(bad).ok, false);
  check('approval granted', await g.escalate(r), true);
  check('authorised after approval', g.authorise(bad).ok, true);
}

// ---------- an irreversible action needs a human even when it matches intent
{
  const g = new Gate({ confirm: alwaysApprove });
  const i = { action: 'approve', chainId: 1, token: USDC, spender: THEM, unlimited: true };
  const tx = { to: USDC, data: call('approve', [THEM, MAX]), value: 0n, chainId: 1 };
  const r = await g.check(i, tx);
  check('declared unlimited approval still needs a human', r.needsHuman, true);
}

// ------------------------- THE PROPERTY: approval does not travel to other bytes
{
  const g = new Gate({ confirm: alwaysApprove });
  const approved = { to: USDC, data: call('transfer', [SIGNER, 100n]), value: 0n, chainId: 1 };
  const mutated = { to: USDC, data: call('transfer', [THEM, 100n]), value: 0n, chainId: 1 };
  await g.escalate(await g.check(intent, approved));
  check('approved bytes authorise', g.authorise(approved).ok, true);
  check('one changed argument voids the approval', g.authorise(mutated).ok, false);
}

// value and chain are part of the binding too
{
  const g = new Gate({ confirm: alwaysApprove });
  const approved = { to: USDC, data: call('transfer', [SIGNER, 1n]), value: 0n, chainId: 1 };
  await g.escalate(await g.check(intent, approved));
  check('added value voids the approval', g.authorise({ ...approved, value: 1n }).ok, false);
  check('changed chain voids the approval', g.authorise({ ...approved, chainId: 8453 }).ok, false);
}

// ------------------------------------------------------------ replay and expiry
{
  const g = new Gate({ confirm: alwaysApprove });
  const tx = { to: USDC, data: call('transfer', [SIGNER, 7n]), value: 0n, chainId: 1 };
  await g.escalate(await g.check(intent, tx));
  check('first use authorised', g.authorise(tx).ok, true);
  check('second use rejected', g.authorise(tx).ok, false);
  check('and says why', g.authorise(tx).reason, 'approval already spent');
}
{
  let t = 1_000_000;
  const g = new Gate({ confirm: alwaysApprove, ttlMs: 60_000, now: () => t });
  const tx = { to: USDC, data: call('transfer', [SIGNER, 8n]), value: 0n, chainId: 1 };
  await g.escalate(await g.check(intent, tx));
  t += 61_000;
  check('expired approval rejected', g.authorise(tx).ok, false);
  check('and says why', g.authorise(tx).reason, 'approval expired');
}

// ------------------------------------------------- a decline authorises nothing
{
  const g = new Gate({ confirm: alwaysDecline });
  const tx = { to: USDC, data: call('transfer', [SIGNER, 9n]), value: 0n, chainId: 1 };
  check('decline returns false', await g.escalate(await g.check(intent, tx)), false);
  check('decline leaves it unauthorised', g.authorise(tx).ok, false);
}

// -------------------------------- simulation does not run on an undecodable call
// If it did, balance movement would be reported as if it confirmed something,
// when there is no decoded deed to confirm it against.
{
  let called = false;
  const rpc = { async simulate() { called = true; return [{ calls: [] }]; } };
  const g = new Gate({ rpc });
  const r = await g.check(intent, { to: USDC, data: '0xdeadbeef', value: 0n, chainId: 1 }, { from: ME });
  check('undecodable call refuses', r.level, Level.REFUSE);
  check('and simulation was not consulted', called, false);
}

// ------------------------------- decode passes but simulation catches the truth
{
  const rpc = {
    async simulate(blocks) {
      const tokens = [];
      for (const c of blocks[0].calls) { if (c.from) break; tokens.push(getAddress(c.to)); }
      return [{
        calls: [
          ...tokens.map(() => ({ returnData: u256(1000n), status: '0x1' })),
          { status: '0x1', returnData: '0x' },
          ...tokens.map(() => ({ returnData: u256(880n), status: '0x1' })),
        ],
      }];
    },
  };
  const g = new Gate({ rpc });
  const r = await g.check(intent, honestTx, { from: ME });
  check('calldata-clean but effect-wrong blocks', r.level, Level.BLOCK);
  check('deltas surfaced', r.deltas[USDC], -120n);
}

// -------------------------------------------------- the on-chain record shape
{
  const g = new Gate();
  const bad = { to: USDC, data: call('transfer', [SIGNER, 100n]), value: 0n, chainId: 1 };
  const rec = g.toRecord(await g.check(intent, bad));
  check('level encoded', rec.level, 1);
  check('findings non-zero for a block', rec.findings > 0, true);
  const clean = g.toRecord(await g.check(intent, honestTx));
  check('clean record satisfies the contract invariant', clean.level === 0 && clean.findings === 0, true);
}

// ------------------------------------- the device message names the exact deed
{
  const m = LedgerPort.message({ deedHash: '0xabc', level: 'BLOCK', reason: 'wrong recipient' });
  check('message carries the deed hash', m.includes('0xabc'), true);
  check('message carries the reason', m.includes('wrong recipient'), true);
}

// -------------------- device failures are classified, not lumped together
// A refusal and a wrong-app error are different events. Recording the second
// as the first would log a human decision that never happened.
{
  const c = (code, message) => LedgerPort.classify(Object.assign(new Error(message), { statusCode: code }));
  check('refusal recognised', c(0x6985, 'Ledger device: Condition of use not satisfied'), 'declined on device');
  check('wrong app recognised', c(0x6d00, 'Ledger device: INS_NOT_SUPPORTED (0x6d00)'),
    'wrong app open on device, the Ethereum app must be running');
  check('locked device recognised', c(0x5515, 'Ledger device: Locked device'), 'device is locked');
  check('wrong app is not a refusal',
    c(0x6d00, 'INS_NOT_SUPPORTED') === 'declined on device', false);
  check('unknown code falls through with its message',
    c(0x1234, 'weird').startsWith('device error:'), true);
}

console.log(out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
