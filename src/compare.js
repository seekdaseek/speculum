// speculum — comparison
//
// Takes the declared Intent and the derived Deed and reports every way they
// come apart. Says nothing it cannot support from one of the two.

import { decode } from './decode.js';
import { Level, Finding, FINDING_LEVEL, FINDING_TEXT, IRREVERSIBLE, worst } from './types.js';

const same = (a, b) =>
  a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase();

/**
 * Compare a declared intent against a transaction.
 *
 * @param {object} intent  what the agent says it is doing
 * @param {object} tx      the transaction it is about to sign
 * @param {{amountTolerance?: number}} [opts]
 *        amountTolerance  fraction the deed may exceed the intent by, for
 *                         routers that pad. Default 0: no slack at all.
 * @returns {{level:string, findings:Array, deed:object, irreversible:boolean}}
 */
export function compare(intent, tx, opts = {}) {
  const tolerance = opts.amountTolerance ?? 0;
  const deed = decode(tx);
  const findings = [];

  const add = (code, detail) =>
    findings.push({ code, level: FINDING_LEVEL[code], why: FINDING_TEXT[code], detail });

  // Flags the bytes raised on their own, before any comparison.
  for (const f of deed.flags) {
    // An unbounded approval is only a divergence if a bounded one was declared.
    // If the agent openly declared an unlimited approval it is still
    // irreversible and still needs a human, but it is not a lie.
    if (f === Finding.UNBOUNDED_APPROVAL && intent.unlimited === true) {
      add(f, 'declared as unlimited by the agent');
      continue;
    }
    add(f);
  }

  // If the deed could not be determined there is nothing to compare against.
  // Do not fall through and emit mismatches derived from missing fields.
  const undetermined = findings.some((f) => f.level === Level.REFUSE);
  if (undetermined) {
    return { level: Level.REFUSE, findings, deed, irreversible: false };
  }

  if (intent.chainId != null && deed.chainId !== intent.chainId) {
    add(Finding.CHAIN_MISMATCH, `declared ${intent.chainId}, calldata targets ${deed.chainId}`);
  }

  if (intent.action && deed.action && intent.action !== deed.action) {
    add(Finding.ACTION_MISMATCH, `declared ${intent.action}, calldata performs ${deed.action}`);
  }

  if (intent.token && deed.asset && deed.asset !== 'native' && !same(intent.token, deed.asset)) {
    add(Finding.TOKEN_MISMATCH, `declared ${intent.token}, calldata moves ${deed.asset}`);
  }

  if (intent.recipient && deed.recipient && !same(intent.recipient, deed.recipient)) {
    add(Finding.RECIPIENT_MISMATCH, `declared ${intent.recipient}, calldata sends to ${deed.recipient}`);
  }

  if (intent.spender && deed.spender && !same(intent.spender, deed.spender)) {
    add(Finding.SPENDER_MISMATCH, `declared ${intent.spender}, calldata approves ${deed.spender}`);
  }

  if (intent.amount != null && deed.amount != null) {
    const declared = BigInt(intent.amount);
    const ceiling = declared + (declared * BigInt(Math.round(tolerance * 10_000))) / 10_000n;
    if (deed.amount > ceiling) {
      add(Finding.AMOUNT_EXCEEDS_INTENT, `declared ${declared}, calldata moves ${deed.amount}`);
    }
  }

  // Native currency riding along on a call that never mentioned it.
  const declaredNative =
    BigInt(intent.value ?? 0) > 0n || (intent.token === 'native' ? BigInt(intent.amount ?? 0) : 0n) > 0n;
  if (deed.value > 0n && !declaredNative) {
    add(Finding.NATIVE_VALUE_UNDECLARED, `calldata attaches ${deed.value} wei`);
  }

  const irreversible = findings.some((f) => IRREVERSIBLE.has(f.code));
  const level = worst(findings.map((f) => f.level));

  return { level, findings, deed, irreversible };
}

/**
 * One-line reason for a human, used on the Ledger screen where space is small.
 * Returns the single most serious finding rather than a list.
 */
export function headline(result) {
  if (!result.findings.length) return 'matches the declared intent';
  const order = [Level.REFUSE, Level.BLOCK];
  for (const lvl of order) {
    const f = result.findings.find((x) => x.level === lvl);
    if (f) return f.why;
  }
  return result.findings[0].why;
}
