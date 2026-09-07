// speculum — comparison
//
// Takes the declared Intent and the derived Deed and reports every way they
// come apart. Says nothing it cannot support from one of the two.
//
// A batch is compared leg by leg, and every finding a leg raises names that
// leg in its detail. A verdict on a batch is only useful to an operator if it
// says which leg earned it.

import { decode } from './decode.js';
import { Action, Level, Finding, FINDING_LEVEL, FINDING_TEXT, IRREVERSIBLE, worst } from './types.js';

const same = (a, b) =>
  a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase();

/** Actions the intent declares. A batch declares every action it contains. */
const declaredActions = (intent) =>
  intent.action == null ? [] : Array.isArray(intent.action) ? intent.action : [intent.action];

/**
 * Every leg of a batch, depth first, each with the path an operator would use
 * to find it: "0" for the first leg, "0.1" for the second leg of a batch
 * nested inside it. Batches themselves are yielded too, marked, because a
 * nested batch can carry a flag of its own (a cap refusal) even though it has
 * no fields to compare.
 */
function* legsOf(deed, prefix = null) {
  for (const leg of deed.legs ?? []) {
    const path = prefix == null ? String(leg.index) : `${prefix}.${leg.index}`;
    yield { path, deed: leg, batch: Boolean(leg.legs) };
    if (leg.legs) yield* legsOf(leg, path);
  }
}

/**
 * Compare a declared intent against a transaction.
 *
 * @param {object} intent  what the agent says it is doing. `action` is one of
 *                         Action, or an array of them for a batch.
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

  // A flag the bytes raised on their own, before any comparison. `path` is the
  // leg it came from, or null for the call itself.
  const flag = (d, code, path) => {
    const notes = [];
    // An unbounded approval is only a divergence if a bounded one was declared.
    // If the agent openly declared an unlimited approval it is still
    // irreversible and still needs a human, but it is not a lie.
    if (code === Finding.UNBOUNDED_APPROVAL && intent.unlimited === true) {
      notes.push('declared as unlimited by the agent');
    }
    if (d.detail?.[code]) notes.push(d.detail[code]);
    // Which selector a leg failed on is the one thing an operator cannot see
    // from the batch's own selector.
    if (path != null && d.selector &&
        (code === Finding.UNKNOWN_SELECTOR || code === Finding.ARGUMENTS_UNDECODABLE)) {
      notes.push(`selector ${d.selector}`);
    }
    const text = notes.join(', ');
    if (path == null) add(code, text || undefined);
    else add(code, text ? `leg ${path}: ${text}` : `leg ${path}`);
  };

  for (const f of deed.flags) flag(deed, f, null);
  for (const { path, deed: leg } of legsOf(deed)) for (const f of leg.flags) flag(leg, f, path);

  // If the deed could not be determined there is nothing to compare against.
  // Do not fall through and emit mismatches derived from missing fields. One
  // undecodable leg makes the whole batch undeterminable, for the same reason.
  const undetermined = findings.some((f) => f.level === Level.REFUSE);
  if (undetermined) {
    return { level: Level.REFUSE, findings, deed, irreversible: false };
  }

  if (intent.chainId != null && deed.chainId !== intent.chainId) {
    add(Finding.CHAIN_MISMATCH, `declared ${intent.chainId}, calldata targets ${deed.chainId}`);
  }

  // The calls that carry fields: the call itself, or each leaf leg of a batch.
  const calls = deed.legs
    ? [...legsOf(deed)].filter((l) => !l.batch)
    : [{ path: null, deed }];
  const actions = declaredActions(intent);

  for (const { path, deed: d } of calls) {
    const at = path == null ? '' : `leg ${path}: `;

    if (actions.length && d.action && !actions.includes(d.action)) {
      add(Finding.ACTION_MISMATCH, `${at}declared ${actions.join(' or ')}, calldata performs ${d.action}`);
    }

    if (intent.token && d.asset && d.asset !== 'native' && !same(intent.token, d.asset)) {
      add(Finding.TOKEN_MISMATCH, `${at}declared ${intent.token}, calldata moves ${d.asset}`);
    }

    if (intent.recipient && d.recipient && !same(intent.recipient, d.recipient)) {
      add(Finding.RECIPIENT_MISMATCH, `${at}declared ${intent.recipient}, calldata sends to ${d.recipient}`);
    }

    if (intent.spender && d.spender && !same(intent.spender, d.spender)) {
      add(Finding.SPENDER_MISMATCH, `${at}declared ${intent.spender}, calldata approves ${d.spender}`);
    }
  }

  if (intent.amount != null) {
    const declared = BigInt(intent.amount);
    const ceiling = declared + (declared * BigInt(Math.round(tolerance * 10_000))) / 10_000n;

    if (!deed.legs) {
      if (deed.amount != null && deed.amount > ceiling) {
        add(Finding.AMOUNT_EXCEEDS_INTENT, `declared ${declared}, calldata moves ${deed.amount}`);
      }
    } else {
      // An approval is checked on its own, since each one grants allowance by
      // itself. Movements are summed per asset, because two legs of half the
      // amount still move the whole of it.
      const moved = new Map();
      for (const { path, deed: d } of calls) {
        if (d.amount == null) continue;
        if (d.action === Action.APPROVE) {
          if (d.amount > ceiling) {
            add(Finding.AMOUNT_EXCEEDS_INTENT, `leg ${path}: declared ${declared}, calldata approves ${d.amount}`);
          }
          continue;
        }
        const m = moved.get(d.asset) ?? { total: 0n, paths: [] };
        m.total += d.amount;
        m.paths.push(path);
        moved.set(d.asset, m);
      }
      for (const m of moved.values()) {
        if (m.total <= ceiling) continue;
        add(Finding.AMOUNT_EXCEEDS_INTENT, m.paths.length === 1
          ? `leg ${m.paths[0]}: declared ${declared}, calldata moves ${m.total}`
          : `legs ${m.paths.join(', ')}: declared ${declared}, calldata moves ${m.total} between them`);
      }
    }
  }

  // Native currency riding along on a call that never mentioned it. For a
  // batch, deed.value is already the envelope plus every leg.
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
