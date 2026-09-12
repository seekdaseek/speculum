// speculum — zero-setup demo tests
//
// `npm run try` is the one command a reader can run with nothing configured,
// so its output is the first thing anyone sees. That makes it worth pinning:
// every verdict and every finding code below is recorded here, and a change
// to a rule in `src/compare.js` or `src/decode.js` breaks this file rather
// than quietly changing what a judge is shown.
//
// The last two groups matter most. One asserts the demo covers each class the
// brief asked for. The other asserts the case definitions carry no expected
// result at all, so the verdicts on screen can only have come from the engine.

import { CASES, run, codesOf, report } from '../bin/try.js';
import { Level, Finding } from '../src/types.js';

let pass = 0, fail = 0;
const out = [];
const check = (n, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  out.push(`${ok ? 'ok  ' : 'FAIL'}  ${n}${ok ? '' : `   got ${String(got).slice(0, 140)}, want ${String(want).slice(0, 140)}`}`);
};

// ------------------------------------------------- the verdict for each case
const PINNED = {
  'the agent meant what it said': { level: Level.PASS, codes: [] },
  'an exact approval that comes out unlimited': {
    level: Level.BLOCK, codes: [Finding.UNBOUNDED_APPROVAL, Finding.AMOUNT_EXCEEDS_INTENT],
  },
  'more moves than was declared': { level: Level.BLOCK, codes: [Finding.AMOUNT_EXCEEDS_INTENT] },
  'the funds land somewhere the agent never named': { level: Level.BLOCK, codes: [Finding.RECIPIENT_MISMATCH] },
  'a function nobody can identify': { level: Level.REFUSE, codes: [Finding.UNKNOWN_SELECTOR] },
  'a batch where one leg out of two decides it': {
    level: Level.BLOCK, codes: [Finding.UNBOUNDED_APPROVAL, Finding.AMOUNT_EXCEEDS_INTENT],
  },
};

check('every case is pinned, and every pin has a case',
  CASES.map((c) => c.name).sort().join('|'), Object.keys(PINNED).sort().join('|'));

const results = new Map();
for (const c of CASES) {
  const r = run(c);
  results.set(c.name, r);
  check(`${c.name}: verdict`, r.level, PINNED[c.name].level);
  check(`${c.name}: reasons`, codesOf(r).join(','), PINNED[c.name].codes.join(','));
}

// ---------------------------------------------------- the details on screen
{
  const refusal = results.get('a function nobody can identify');
  check('a refusal emits one finding, not a pile', refusal.findings.length, 1);
  check('and invents no mismatch from fields it never read',
    refusal.findings.some((f) => f.code === Finding.RECIPIENT_MISMATCH), false);

  const unlimited = results.get('an exact approval that comes out unlimited');
  check('an unlimited approval is irreversible', unlimited.irreversible, true);

  const b = results.get('a batch where one leg out of two decides it');
  check('the batch decoded into two legs', b.deed.legs.length, 2);
  check('leg 0 is clean', b.deed.legs[0].flags.length, 0);
  check('leg 1 is the one that raised it', b.deed.legs[1].flags.join(','), Finding.UNBOUNDED_APPROVAL);
  check('and the finding names that leg',
    b.findings.find((f) => f.code === Finding.UNBOUNDED_APPROVAL).detail, 'leg 1');
  check('the amount finding names it too',
    b.findings.find((f) => f.code === Finding.AMOUNT_EXCEEDS_INTENT).detail.startsWith('leg 1:'), true);
  check('one bad leg carries the whole batch', b.level, Level.BLOCK);
}

// ------------------------------------------- the demo covers what it claims
{
  const levels = CASES.map((c) => results.get(c.name).level);
  const codes = CASES.flatMap((c) => codesOf(results.get(c.name)));
  check('at least one PASS', levels.includes(Level.PASS), true);
  check('at least one REFUSE', levels.includes(Level.REFUSE), true);
  check('an unbounded approval is shown', codes.includes(Finding.UNBOUNDED_APPROVAL), true);
  check('an amount divergence is shown', codes.includes(Finding.AMOUNT_EXCEEDS_INTENT), true);
  check('an unknown selector is shown', codes.includes(Finding.UNKNOWN_SELECTOR), true);
  check('a multicall batch is shown', CASES.some((c) => results.get(c.name).deed.legs), true);
  check('an amount divergence is shown on its own, not only beside an unbounded approval',
    CASES.some((c) => codesOf(results.get(c.name)).join(',') === Finding.AMOUNT_EXCEEDS_INTENT), true);
}

// -------------------------------------- nothing on screen is written down
// A case is a name, a declaration and a transaction. If a verdict or a
// finding could be spelled here, the output would prove nothing about the
// engine, which is the whole point of the command.
for (const c of CASES) {
  check(`${c.name}: carries no canned result`, Object.keys(c).sort().join(','), 'intent,name,tx');
}

// --------------------------------------------------------------- the output
{
  const text = report();
  for (const c of CASES) check(`${c.name}: appears in the output`, text.includes(c.name), true);
  check('the verdicts appear', /\bPASS\b/.test(text) && /\bBLOCK\b/.test(text) && /\bREFUSE\b/.test(text), true);
  check('the leg index is visible', text.includes('leg 1'), true);
  check('the closing line states the decoder never saw the intent',
    text.includes('derives the deed from the calldata alone') && text.includes('cannot be circular'), true);
  check('it says up front that nothing is needed to run it',
    text.includes('no network, no keys, no chain'), true);
}

console.log(out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
