// speculum — tests
//
// Every case below is a transaction an agent could plausibly produce while
// stating something else. Calldata is encoded with viem, so the bytes under
// test are real bytes, not hand-written strings that happen to parse.

import { encodeFunctionData, parseAbi } from 'viem';
import { compare, headline } from '../src/compare.js';
import { Level, Finding } from '../src/types.js';
import { ABI, MAX_DEPTH, MAX_LEGS } from '../src/decode.js';

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const ME = '0x22DB3A9686EE5261e7Bf3ed4f91277232E8076e6';
const THEM = '0x000000000000000000000000000000000000dEaD';
const ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
const MAX = (1n << 256n) - 1n;

const call = (name, args) => encodeFunctionData({ abi: ABI, functionName: name, args });

let pass = 0, fail = 0;
const results = [];

function check(name, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  results.push(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `   got ${got}, want ${want}`}`);
  return ok;
}

function has(name, result, code) {
  const ok = result.findings.some((f) => f.code === code);
  ok ? pass++ : fail++;
  results.push(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `   missing ${code}, got [${result.findings.map(f=>f.code)}]`}`);
}

// ---------------------------------------------------------------- honest case
{
  const intent = { action: 'transfer', chainId: 1, token: USDC, amount: 100_000000n, recipient: THEM };
  const tx = { to: USDC, data: call('transfer', [THEM, 100_000000n]), value: 0n, chainId: 1 };
  const r = compare(intent, tx);
  check('honest transfer passes', r.level, Level.PASS);
  check('honest transfer has no findings', r.findings.length, 0);
  check('headline reads clean', headline(r), 'matches the declared intent');
}

// ------------------------------------------------- the recipient was swapped
{
  const intent = { action: 'transfer', chainId: 1, token: USDC, amount: 100_000000n, recipient: ME };
  const tx = { to: USDC, data: call('transfer', [THEM, 100_000000n]), value: 0n, chainId: 1 };
  const r = compare(intent, tx);
  check('swapped recipient blocks', r.level, Level.BLOCK);
  has('swapped recipient names the class', r, Finding.RECIPIENT_MISMATCH);
}

// ---------------------------------- exact amount declared, unlimited approved
{
  const intent = { action: 'approve', chainId: 1, token: USDC, amount: 100_000000n, spender: ROUTER };
  const tx = { to: USDC, data: call('approve', [ROUTER, MAX]), value: 0n, chainId: 1 };
  const r = compare(intent, tx);
  check('unlimited approval blocks', r.level, Level.BLOCK);
  has('unlimited approval named', r, Finding.UNBOUNDED_APPROVAL);
  has('and the amount divergence too', r, Finding.AMOUNT_EXCEEDS_INTENT);
  check('flagged irreversible', r.irreversible, true);
}

// --------------------------- unlimited approval that was honestly declared
{
  const intent = { action: 'approve', chainId: 1, token: USDC, spender: ROUTER, unlimited: true };
  const tx = { to: USDC, data: call('approve', [ROUTER, MAX]), value: 0n, chainId: 1 };
  const r = compare(intent, tx);
  check('declared unlimited still blocks', r.level, Level.BLOCK);
  check('but is marked as declared', r.findings[0].detail, 'declared as unlimited by the agent');
}

// ------------------------------------------------- approving the wrong spender
{
  const intent = { action: 'approve', chainId: 1, token: USDC, amount: 50n, spender: ROUTER };
  const tx = { to: USDC, data: call('approve', [THEM, 50n]), value: 0n, chainId: 1 };
  const r = compare(intent, tx);
  has('wrong spender named', r, Finding.SPENDER_MISMATCH);
}

// ------------------------------------------- says swap, actually setApprovalForAll
// This is the Lirix case: the class of call itself is a lie.
{
  const intent = { action: 'swap', chainId: 1, token: USDC, amount: 100n };
  const tx = { to: USDC, data: call('setApprovalForAll', [THEM, true]), value: 0n, chainId: 1 };
  const r = compare(intent, tx);
  check('swap-that-is-an-approval blocks', r.level, Level.BLOCK);
  has('action divergence named', r, Finding.ACTION_MISMATCH);
  has('blanket approval named', r, Finding.APPROVAL_FOR_ALL);
}

// ------------------------------------------------------- the token was swapped
{
  const intent = { action: 'transfer', chainId: 1, token: USDC, amount: 1n, recipient: THEM };
  const tx = { to: WETH, data: call('transfer', [THEM, 1n]), value: 0n, chainId: 1 };
  const r = compare(intent, tx);
  has('token divergence named', r, Finding.TOKEN_MISMATCH);
}

// ------------------------------------------------------------- wrong chain
{
  const intent = { action: 'transfer', chainId: 1, token: USDC, amount: 1n, recipient: THEM };
  const tx = { to: USDC, data: call('transfer', [THEM, 1n]), value: 0n, chainId: 8453 };
  const r = compare(intent, tx);
  has('chain divergence named', r, Finding.CHAIN_MISMATCH);
}

// ---------------------------------------------- native value riding along
{
  const intent = { action: 'approve', chainId: 1, token: USDC, amount: 1n, spender: ROUTER };
  const tx = { to: USDC, data: call('approve', [ROUTER, 1n]), value: 5n * 10n ** 17n, chainId: 1 };
  const r = compare(intent, tx);
  has('undeclared native value named', r, Finding.NATIVE_VALUE_UNDECLARED);
}

// -------------------------------------------------- a swap that is honest
{
  const params = {
    tokenIn: USDC, tokenOut: WETH, fee: 500, recipient: ME,
    amountIn: 1000_000000n, amountOutMinimum: 3n * 10n ** 17n, sqrtPriceLimitX96: 0n,
  };
  const intent = { action: 'swap', chainId: 1, token: USDC, amount: 1000_000000n, recipient: ME };
  const tx = { to: ROUTER, data: call('exactInputSingle', [params]), value: 0n, chainId: 1 };
  const r = compare(intent, tx);
  check('honest swap passes', r.level, Level.PASS);
}

// ------------------------------- a swap that sends the output somewhere else
// The Cobo incident shape: right trade, wrong destination.
{
  const params = {
    tokenIn: USDC, tokenOut: WETH, fee: 500, recipient: THEM,
    amountIn: 1000_000000n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
  };
  const intent = { action: 'swap', chainId: 1, token: USDC, amount: 1000_000000n, recipient: ME };
  const tx = { to: ROUTER, data: call('exactInputSingle', [params]), value: 0n, chainId: 1 };
  const r = compare(intent, tx);
  check('swap to a foreign address blocks', r.level, Level.BLOCK);
  has('and names the recipient', r, Finding.RECIPIENT_MISMATCH);
}

// --------------------------------------------------------- ownership and proxy
{
  const intent = { action: 'transfer', chainId: 1, amount: 0n };
  const r1 = compare(intent, { to: ME, data: call('transferOwnership', [THEM]), value: 0n, chainId: 1 });
  has('ownership transfer named', r1, Finding.OWNERSHIP_TRANSFER);
  check('ownership transfer is irreversible', r1.irreversible, true);

  const r2 = compare(intent, { to: ME, data: call('upgradeTo', [THEM]), value: 0n, chainId: 1 });
  has('proxy upgrade named', r2, Finding.PROXY_UPGRADE);
}

// ------------------------------------------------------------ refusal states
{
  const intent = { action: 'transfer', chainId: 1, token: USDC, amount: 1n, recipient: THEM };

  const r1 = compare(intent, { to: USDC, data: '0xdeadbeef', value: 0n, chainId: 1 });
  check('unknown selector refuses', r1.level, Level.REFUSE);
  has('unknown selector named', r1, Finding.UNKNOWN_SELECTOR);
  check('refusal emits no invented mismatches', r1.findings.length, 1);

  const r2 = compare(intent, { to: USDC, data: '0xabc', value: 0n, chainId: 1 });
  check('malformed calldata refuses', r2.level, Level.REFUSE);

  const r3 = compare(intent, {
    to: ROUTER, data: call('multicall', [0n, ['0x1234']]), value: 0n, chainId: 1,
  });
  check('batch with a malformed leg refuses', r3.level, Level.REFUSE);
  has('and says the leg is malformed', r3, Finding.MALFORMED_CALLDATA);
  check('and names the leg', r3.findings[0].detail, 'leg 0');
}

// --------------------------- a refusal must never be softened into a pass
{
  const intent = { action: 'transfer', chainId: 1, token: USDC, amount: 1n, recipient: THEM };
  const r = compare(intent, { to: USDC, data: '0xdeadbeef' + '00'.repeat(32), value: 0n, chainId: 1 });
  check('unknown selector with padding still refuses', r.level, Level.REFUSE);
}

// ------------------------------------------------------------------ batches
// A multicall is decoded leg by leg. Every leg of `multicall(deadline, bytes[])`
// runs against the batch's own target, since the router delegatecalls into
// itself, so an approve leg can only ever approve the target's token. The
// clean batch below is addressed to the token for exactly that reason. The
// intent declares every action the batch performs.
const batch = (legs) => call('multicall', [0n, legs]);
const swapParams = (recipient, amountIn) => ({
  tokenIn: USDC, tokenOut: WETH, fee: 500, recipient,
  amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
});
const detailOf = (r, code) => r.findings.filter((f) => f.code === code).map((f) => f.detail);

// exact approve, then the swap it enables, declared as both
{
  const intent = {
    action: ['approve', 'swap'], chainId: 1, token: USDC, amount: 1000_000000n,
    spender: ROUTER, recipient: ME,
  };
  const legs = [call('approve', [ROUTER, 1000_000000n]), call('exactInputSingle', [swapParams(ME, 1000_000000n)])];
  const r = compare(intent, { to: USDC, data: batch(legs), value: 0n, chainId: 1 });
  check('clean two-leg batch passes', r.level, Level.PASS);
  check('clean batch has no findings', r.findings.length, 0);
  check('both legs decoded', r.deed.legs.length, 2);
  check('leg 0 is the approve', r.deed.legs[0].action, 'approve');
  check('leg 1 is the swap', r.deed.legs[1].action, 'swap');
  check('actions collected as a set', r.deed.actions.join(','), 'approve,swap');
  check('assets collapse to the one token', r.deed.assets.join(','), USDC);
  check('recipients collected', r.deed.recipients.join(','), ME);
}

// one leg approves without bound where an exact amount was declared
{
  const intent = {
    action: ['approve', 'swap'], chainId: 1, token: USDC, amount: 1000_000000n,
    spender: ROUTER, recipient: ME,
  };
  const legs = [call('approve', [ROUTER, MAX]), call('exactInputSingle', [swapParams(ME, 1000_000000n)])];
  const r = compare(intent, { to: USDC, data: batch(legs), value: 0n, chainId: 1 });
  check('unbounded approval leg blocks the batch', r.level, Level.BLOCK);
  has('unbounded approval named', r, Finding.UNBOUNDED_APPROVAL);
  check('and the finding names the leg', detailOf(r, Finding.UNBOUNDED_APPROVAL)[0], 'leg 0');
  check('the amount excess names the leg too', detailOf(r, Finding.AMOUNT_EXCEEDS_INTENT)[0].startsWith('leg 0:'), true);
  check('batch is irreversible', r.irreversible, true);
}

// one leg is a selector speculum does not know: the whole batch refuses
{
  const intent = { action: ['approve', 'swap'], chainId: 1, token: USDC, amount: 1000_000000n, spender: ROUTER };
  const legs = [call('approve', [ROUTER, 1000_000000n]), '0xdeadbeef'];
  const r = compare(intent, { to: USDC, data: batch(legs), value: 0n, chainId: 1 });
  check('unknown leg refuses the batch', r.level, Level.REFUSE);
  check('exactly one finding, no pile', r.findings.length, 1);
  check('it is the unknown selector', r.findings[0].code, Finding.UNKNOWN_SELECTOR);
  check('and it names the leg', r.findings[0].detail, 'leg 1: selector 0xdeadbeef');
}

// unknown selector and unreadable arguments stay distinct inside a batch
{
  const intent = { action: 'transfer', chainId: 1, token: USDC, amount: 1n };
  const truncated = call('approve', [ROUTER, 1n]).slice(0, 20);
  const legs = ['0xdeadbeef', truncated];
  const r = compare(intent, { to: USDC, data: batch(legs), value: 0n, chainId: 1 });
  check('both legs refuse', r.level, Level.REFUSE);
  check('leg 0 is unknown', detailOf(r, Finding.UNKNOWN_SELECTOR)[0], 'leg 0: selector 0xdeadbeef');
  check('leg 1 is known but unreadable', detailOf(r, Finding.ARGUMENTS_UNDECODABLE)[0], 'leg 1: selector 0x095ea7b3');
}

// a leg-level mismatch names its leg
{
  const intent = { action: 'transfer', chainId: 1, token: USDC, amount: 100n, recipient: ME };
  const legs = [call('transfer', [ME, 100n]), call('transfer', [THEM, 100n])];
  const r = compare(intent, { to: USDC, data: batch(legs), value: 0n, chainId: 1 });
  has('foreign recipient in leg 1 named', r, Finding.RECIPIENT_MISMATCH);
  check('with its leg index', detailOf(r, Finding.RECIPIENT_MISMATCH)[0].startsWith('leg 1:'), true);
}

// two legs each within the declared amount still move more than declared
{
  const intent = { action: 'transfer', chainId: 1, token: USDC, amount: 100n, recipient: THEM };
  const legs = [call('transfer', [THEM, 60n]), call('transfer', [THEM, 60n])];
  const r = compare(intent, { to: USDC, data: batch(legs), value: 0n, chainId: 1 });
  check('split movement blocks', r.level, Level.BLOCK);
  check('and names both legs', detailOf(r, Finding.AMOUNT_EXCEEDS_INTENT)[0], 'legs 0, 1: declared 100, calldata moves 120 between them');
}

// a leg whose action the intent never declared
{
  const intent = { action: 'swap', chainId: 1, token: USDC, amount: 1000_000000n, recipient: ME };
  const legs = [call('approve', [ROUTER, 1000_000000n]), call('exactInputSingle', [swapParams(ME, 1000_000000n)])];
  const r = compare(intent, { to: USDC, data: batch(legs), value: 0n, chainId: 1 });
  check('undeclared approve leg blocks', r.level, Level.BLOCK);
  check('and names it', detailOf(r, Finding.ACTION_MISMATCH)[0], 'leg 0: declared swap, calldata performs approve');
}

// native value on the envelope is the batch's value
{
  const intent = { action: 'transfer', chainId: 1, token: USDC, amount: 1n, recipient: THEM };
  const r = compare(intent, { to: USDC, data: batch([call('transfer', [THEM, 1n])]), value: 7n, chainId: 1 });
  has('undeclared value on a batch named', r, Finding.NATIVE_VALUE_UNDECLARED);
  check('batch value is the envelope plus every leg', r.deed.value, 7n);
}

// nesting: one batch inside another is within the cap and its legs get a path
{
  const intent = { action: 'transfer', chainId: 1, token: USDC, amount: 1n, recipient: THEM };
  let data = call('transfer', [ME, 1n]);
  for (let i = 1; i < MAX_DEPTH; i++) data = batch([data]);
  const r = compare(intent, { to: USDC, data, value: 0n, chainId: 1 });
  check('nested batch within the cap decodes', r.level, Level.BLOCK);
  check('and the path reaches the inner leg', detailOf(r, Finding.RECIPIENT_MISMATCH)[0].startsWith(`leg ${Array(MAX_DEPTH - 1).fill('0').join('.')}:`), true);
}

// nesting past the depth cap refuses instead of recursing
{
  const intent = { action: 'transfer', chainId: 1, token: USDC, amount: 1n, recipient: THEM };
  let data = call('transfer', [THEM, 1n]);
  for (let i = 0; i < MAX_DEPTH; i++) data = batch([data]);
  const r = compare(intent, { to: USDC, data, value: 0n, chainId: 1 });
  check('nested past the depth cap refuses', r.level, Level.REFUSE);
  has('as unreadable arguments, not unknown', r, Finding.ARGUMENTS_UNDECODABLE);
  check('exactly one finding', r.findings.length, 1);
  check('and it says why', r.findings[0].detail.includes(`cap is ${MAX_DEPTH}`), true);
}

// ---------------------------------------- the V3 SwapRouter overload, no deadline
// Same legs, second selector. The deadline is not load-bearing: the two
// overloads must decode to identical legs, and the caps must hold for both.
const batchV3 = (legs) => call('multicall', [legs]);
const legsJson = (r) => JSON.stringify(r.deed.legs, (k, v) => (typeof v === 'bigint' ? `${v}n` : v));

{
  const intent = {
    action: ['approve', 'swap'], chainId: 1, token: USDC, amount: 1000_000000n,
    spender: ROUTER, recipient: ME,
  };
  const legs = [call('approve', [ROUTER, 1000_000000n]), call('exactInputSingle', [swapParams(ME, 1000_000000n)])];
  const v3 = compare(intent, { to: USDC, data: batchV3(legs), value: 0n, chainId: 1 });
  const v2 = compare(intent, { to: USDC, data: batch(legs), value: 0n, chainId: 1 });
  check('no-deadline overload has its own selector', v3.deed.selector, '0xac9650d8');
  check('and it is not the deadline one', v3.deed.selector === v2.deed.selector, false);
  check('V3-shaped batch decodes into legs', v3.deed.legs?.length, 2);
  check('V3-shaped batch does not refuse', v3.level, Level.PASS);
  check('both overloads decode the same legs byte for byte', legsJson(v3), legsJson(v2));
  check('and reach the same verdict', v3.level, v2.level);
}

// the same divergence is found through either overload, naming the same leg
{
  const intent = { action: 'transfer', chainId: 1, token: USDC, amount: 100n, recipient: ME };
  const legs = [call('transfer', [ME, 100n]), call('transfer', [THEM, 100n])];
  const v3 = compare(intent, { to: USDC, data: batchV3(legs), value: 0n, chainId: 1 });
  const v2 = compare(intent, { to: USDC, data: batch(legs), value: 0n, chainId: 1 });
  check('findings identical across overloads', JSON.stringify(v3.findings), JSON.stringify(v2.findings));
  check('and the leg is named', detailOf(v3, Finding.RECIPIENT_MISMATCH)[0].startsWith('leg 1:'), true);
}

// depth cap on the no-deadline overload, including when the frames are mixed
{
  const intent = { action: 'transfer', chainId: 1, token: USDC, amount: 1n, recipient: THEM };
  let data = call('transfer', [THEM, 1n]);
  for (let i = 0; i < MAX_DEPTH; i++) data = batchV3([data]);
  const r = compare(intent, { to: USDC, data, value: 0n, chainId: 1 });
  check('V3 nesting past the depth cap refuses', r.level, Level.REFUSE);
  check('with the reason', r.findings[0].detail.includes(`cap is ${MAX_DEPTH}`), true);

  let mixed = call('transfer', [THEM, 1n]);
  for (let i = 0; i < MAX_DEPTH; i++) mixed = i % 2 ? batch([mixed]) : batchV3([mixed]);
  const m = compare(intent, { to: USDC, data: mixed, value: 0n, chainId: 1 });
  check('mixed overloads count toward the same depth', m.level, Level.REFUSE);
}

// leg cap on the no-deadline overload
{
  const intent = { action: 'transfer', chainId: 1, token: USDC, amount: 1n, recipient: THEM };
  const r = compare(intent, { to: USDC, data: batchV3(Array(MAX_LEGS + 1).fill(call('transfer', [THEM, 1n]))), value: 0n, chainId: 1 });
  check('V3 batch over the leg cap refuses', r.level, Level.REFUSE);
  check('with the count', r.findings[0].detail, `${MAX_LEGS + 1} legs, cap is ${MAX_LEGS}`);
  const ok = compare(intent, { to: USDC, data: batchV3(Array(MAX_LEGS).fill(call('transfer', [THEM, 1n]))), value: 0n, chainId: 1 });
  check('and exactly at the cap still decodes', ok.deed.legs?.length, MAX_LEGS);
}

// more legs than the cap refuses without decoding any of them
{
  const intent = { action: 'transfer', chainId: 1, token: USDC, amount: 1n, recipient: THEM };
  const legs = Array(MAX_LEGS + 1).fill(call('transfer', [THEM, 1n]));
  const r = compare(intent, { to: USDC, data: batch(legs), value: 0n, chainId: 1 });
  check('too many legs refuses', r.level, Level.REFUSE);
  check('with the count', r.findings[0].detail, `${MAX_LEGS + 1} legs, cap is ${MAX_LEGS}`);
  check('and no legs were decoded', r.deed.legs, undefined);
}

// -------------------------------------------------- tolerance behaves as set
{
  const intent = { action: 'transfer', chainId: 1, token: USDC, amount: 100n, recipient: THEM };
  const tx = { to: USDC, data: call('transfer', [THEM, 101n]), value: 0n, chainId: 1 };
  check('no tolerance by default', compare(intent, tx).level, Level.BLOCK);
  check('1 percent tolerance admits it', compare(intent, tx, { amountTolerance: 0.01 }).level, Level.PASS);
}

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
