#!/usr/bin/env node
// speculum — run the divergence cases with nothing set up
//
// Every other script in this repository needs something first: an RPC
// endpoint, a deploy key, a funded Hedera account, a subgraph API key. This
// one needs none of them. No network, no chain, no wallet, no configuration.
//
//   npm run try
//
// It builds real calldata with viem and hands it to the same two modules the
// paid service runs on, `src/decode.js` and `src/compare.js`. Nothing here is
// mocked and no verdict is written down in advance: every line printed under
// "verdict" and "reasons" is whatever the comparator returned for those exact
// bytes. Change a rule in the engine and the output below changes with it,
// which is why `test/try.test.js` pins each case.

import { encodeFunctionData, formatUnits } from 'viem';
import { pathToFileURL } from 'node:url';
import { compare } from '../src/compare.js';
import { ABI, MAX_UINT256, UNBOUNDED_FLOOR } from '../src/decode.js';

// Real mainnet addresses, used as labels only. Nothing is sent anywhere.
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
const MINE = '0x22DB3A9686EE5261e7Bf3ed4f91277232E8076e6';
const THEIRS = '0x000000000000000000000000000000000000dEaD';

const HUNDRED = 100_000000n;          // 100 USDC, six decimals
const HUNDRED_FIFTY = 150_000000n;

const call = (name, args) => encodeFunctionData({ abi: ABI, functionName: name, args });
const batch = (legs) => call('multicall', [legs]);

// ---------------------------------------------------------------- rendering

const TOKENS = {
  [USDC.toLowerCase()]: { symbol: 'USDC', decimals: 6 },
  [WETH.toLowerCase()]: { symbol: 'WETH', decimals: 18 },
};

const short = (a) => (a ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : 'nobody');

// A label only where it adds something. The burn address deliberately gets
// none: it is the honest recipient in some cases below and the unexpected one
// in another, and naming it either way would editorialise over the verdict.
const LABELS = {
  [MINE.toLowerCase()]: "the agent's own wallet",
  [ROUTER.toLowerCase()]: 'the Uniswap router',
};
const who = (a) => {
  const label = LABELS[String(a).toLowerCase()];
  return label ? `${short(a)} (${label})` : short(a);
};

/** An amount with its unit, or the word for "no ceiling at all". */
function quantity(n, asset) {
  if (n == null) return 'an unstated amount';
  const t = TOKENS[String(asset).toLowerCase()];
  if (n >= UNBOUNDED_FLOOR) return `an UNLIMITED amount of ${t?.symbol ?? short(asset)}`;
  const unit = t ? t.symbol : short(asset);
  return `${t ? formatUnits(n, t.decimals) : n.toString()} ${unit}`;
}

/** One plain line for what the agent said it was about to do. */
function intentLine(intent) {
  const on = ` on chain ${intent.chainId}`;
  switch (intent.action) {
    case 'transfer':
      return `send ${quantity(BigInt(intent.amount), intent.token)} to ${who(intent.recipient)}${on}`;
    case 'approve':
      return `approve exactly ${quantity(BigInt(intent.amount), intent.token)} for ${who(intent.spender)}${on}`;
    default:
      return `${intent.action} ${quantity(intent.amount == null ? null : BigInt(intent.amount), intent.token)}${on}`;
  }
}

/**
 * One plain line for what a single decoded call does. Inside a batch the
 * addresses go bare, so a six-leg line stays readable in a terminal.
 */
function callLine(d, terse = false) {
  const addr = terse ? short : who;
  switch (d.action) {
    case 'transfer': return `send ${quantity(d.amount, d.asset)} to ${addr(d.recipient)}`;
    case 'approve': return `approve ${quantity(d.amount, d.asset)} for ${addr(d.spender)}`;
    case 'swap': return `swap ${quantity(d.amount, d.asset)} into ${TOKENS[String(d.toAsset).toLowerCase()]?.symbol ?? short(d.toAsset)}, output to ${addr(d.recipient)}`;
    case undefined: return d.selector
      ? `call selector ${d.selector}, which the decoder does not recognise`
      : 'carry calldata the decoder could not read at all';
    default: return `${d.action} ${quantity(d.amount, d.asset)}`;
  }
}

/** One plain line for the whole transaction, batches included. */
function deedLine(deed) {
  const on = `on chain ${deed.chainId}`;
  if (deed.legs) {
    const legs = deed.legs.map((l) => `leg ${l.index} would ${callLine(l, true)}`).join('; ');
    return `run a ${deed.legs.length}-leg multicall batch ${on} — ${legs}`;
  }
  if (!deed.action) {
    return deed.selector
      ? `call selector ${deed.selector} ${on}, which the decoder does not recognise`
      : `carry calldata ${on} that the decoder could not read at all`;
  }
  return `${callLine(deed)} ${on}`;
}

// ------------------------------------------------------------------- cases

export const CASES = [
  {
    name: 'the agent meant what it said',
    intent: { action: 'transfer', chainId: 1, token: USDC, amount: HUNDRED, recipient: THEIRS },
    tx: { to: USDC, data: call('transfer', [THEIRS, HUNDRED]), value: 0n, chainId: 1 },
  },
  {
    name: 'an exact approval that comes out unlimited',
    intent: { action: 'approve', chainId: 1, token: USDC, amount: HUNDRED, spender: ROUTER },
    tx: { to: USDC, data: call('approve', [ROUTER, MAX_UINT256]), value: 0n, chainId: 1 },
  },
  {
    name: 'more moves than was declared',
    intent: { action: 'transfer', chainId: 1, token: USDC, amount: HUNDRED, recipient: THEIRS },
    tx: { to: USDC, data: call('transfer', [THEIRS, HUNDRED_FIFTY]), value: 0n, chainId: 1 },
  },
  {
    name: 'the funds land somewhere the agent never named',
    intent: { action: 'transfer', chainId: 1, token: USDC, amount: HUNDRED, recipient: MINE },
    tx: { to: USDC, data: call('transfer', [THEIRS, HUNDRED]), value: 0n, chainId: 1 },
  },
  {
    name: 'a function nobody can identify',
    intent: { action: 'transfer', chainId: 1, token: USDC, amount: HUNDRED, recipient: THEIRS },
    tx: { to: USDC, data: '0xdeadbeef', value: 0n, chainId: 1 },
  },
  {
    name: 'a batch where one leg out of two decides it',
    intent: { action: 'approve', chainId: 1, token: USDC, amount: HUNDRED, spender: ROUTER },
    tx: {
      to: USDC,
      data: batch([call('approve', [ROUTER, HUNDRED]), call('approve', [ROUTER, MAX_UINT256])]),
      value: 0n,
      chainId: 1,
    },
  },
];

/** The engine, called exactly as the paid service calls it. */
export const run = (c) => compare(c.intent, c.tx);

/** Finding codes in the order the comparator raised them. */
export const codesOf = (result) => result.findings.map((f) => f.code);

// ------------------------------------------------------------------ output

function report() {
  const lines = [];
  lines.push('speculum — what the bytes do, against what the agent said');
  lines.push('no network, no keys, no chain. the engine is src/decode.js and src/compare.js.');

  for (const [i, c] of CASES.entries()) {
    const result = run(c);
    lines.push('');
    lines.push(`${'─'.repeat(72)}`);
    lines.push(`${i + 1}. ${c.name}`);
    lines.push(`   declared   the agent says it will ${intentLine(c.intent)}`);
    lines.push(`   calldata   the bytes would ${deedLine(result.deed)}`);
    lines.push(`   verdict    ${result.level}${result.irreversible ? '   (irreversible once mined)' : ''}`);
    if (!result.findings.length) {
      lines.push('   reasons    none. the declaration and the bytes agree.');
    } else {
      result.findings.forEach((f, n) => {
        const head = n === 0 ? '   reasons    ' : '              ';
        lines.push(`${head}${f.code} — ${f.why}`);
        if (f.detail) lines.push(`              ↳ ${f.detail}`);
      });
    }
  }

  lines.push('');
  lines.push(`${'─'.repeat(72)}`);
  lines.push('The decoder never saw a single intent above: it derives the deed from the calldata alone, and only then is the deed compared, so the check cannot be circular.');
  return lines.join('\n');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) console.log(report());

export { report };
