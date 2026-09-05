// speculum — tests
//
// Every case below is a transaction an agent could plausibly produce while
// stating something else. Calldata is encoded with viem, so the bytes under
// test are real bytes, not hand-written strings that happen to parse.

import { encodeFunctionData, parseAbi } from 'viem';
import { compare, headline } from '../src/compare.js';
import { Level, Finding } from '../src/types.js';
import { ABI } from '../src/decode.js';

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
  check('undecodable batch refuses', r3.level, Level.REFUSE);
}

// --------------------------- a refusal must never be softened into a pass
{
  const intent = { action: 'transfer', chainId: 1, token: USDC, amount: 1n, recipient: THEM };
  const r = compare(intent, { to: USDC, data: '0xdeadbeef' + '00'.repeat(32), value: 0n, chainId: 1 });
  check('unknown selector with padding still refuses', r.level, Level.REFUSE);
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
