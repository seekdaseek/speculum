// speculum — verdict vocabulary for the paid service
//
// The engine speaks in PASS, BLOCK and REFUSE because those are the levels the
// contract emits and the subgraph indexes. The service brief speaks in match,
// divergence and undeterminable. Both are kept on the wire: the level is the
// stable code, the outcome is the word an operator reads. The mapping lives
// here, once, so the service and the agent cannot drift apart on it.

import { Level } from '../src/types.js';

export const Outcome = Object.freeze({
  [Level.PASS]: 'match',
  [Level.BLOCK]: 'divergence',
  [Level.REFUSE]: 'undeterminable',
});

export const outcomeOf = (level) => Outcome[level] ?? 'undeterminable';

/**
 * The deed the decoder derived, as plain JSON. bigint becomes a decimal
 * string, nested legs are kept, nothing is summarised away: an operator
 * reading the response should see the same object the comparator judged.
 */
export function effectsOf(deed) {
  return plain(deed);
}

export function plain(v) {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  }
  return v;
}
