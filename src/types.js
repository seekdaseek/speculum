// speculum — types
//
// Three objects matter.
//
//   Intent  what the agent SAYS it is about to do, declared before signing.
//   Deed    what the calldata ACTUALLY does, derived from the bytes alone.
//   Verdict the comparison, plus every reason it reached that answer.
//
// The Deed is never built from the Intent. If the two shared a code path the
// whole check would be circular, so decoding takes the transaction only.

/** Actions an agent may declare. Anything outside this set is undeclarable. */
export const Action = Object.freeze({
  TRANSFER: 'transfer',
  APPROVE: 'approve',
  SWAP: 'swap',
  DEPOSIT: 'deposit',
  WITHDRAW: 'withdraw',
});

/**
 * Verdict levels, ordered. A run takes the highest level any finding reached.
 *
 * PASS    deed matches intent within tolerance; nothing irreversible undeclared
 * BLOCK   deed and intent disagree, or the deed is irreversible; needs a human
 * REFUSE  the deed could not be determined; speculum does not guess
 *
 * REFUSE outranks BLOCK deliberately. An undecodable call is worse than a
 * decoded mismatch, because a mismatch is at least understood.
 */
export const Level = Object.freeze({
  PASS: 'PASS',
  BLOCK: 'BLOCK',
  REFUSE: 'REFUSE',
});

const RANK = { PASS: 0, BLOCK: 1, REFUSE: 2 };

export function worst(levels) {
  let out = Level.PASS;
  for (const l of levels) if (RANK[l] > RANK[out]) out = l;
  return out;
}

/**
 * Divergence classes. Each is a specific, nameable way an agent's words and
 * its bytes come apart. Codes are stable; they are emitted on-chain and
 * indexed, so renaming one breaks the subgraph.
 */
export const Finding = Object.freeze({
  // --- decoded, and they disagree -----------------------------------------
  ACTION_MISMATCH: 'ACTION_MISMATCH',
  TOKEN_MISMATCH: 'TOKEN_MISMATCH',
  RECIPIENT_MISMATCH: 'RECIPIENT_MISMATCH',
  SPENDER_MISMATCH: 'SPENDER_MISMATCH',
  AMOUNT_EXCEEDS_INTENT: 'AMOUNT_EXCEEDS_INTENT',
  CHAIN_MISMATCH: 'CHAIN_MISMATCH',
  NATIVE_VALUE_UNDECLARED: 'NATIVE_VALUE_UNDECLARED',

  // --- decoded, and it is irreversible or unbounded ------------------------
  UNBOUNDED_APPROVAL: 'UNBOUNDED_APPROVAL',
  APPROVAL_FOR_ALL: 'APPROVAL_FOR_ALL',
  OWNERSHIP_TRANSFER: 'OWNERSHIP_TRANSFER',
  PROXY_UPGRADE: 'PROXY_UPGRADE',
  SELF_DESTRUCT: 'SELF_DESTRUCT',

  // --- could not be determined --------------------------------------------
  UNKNOWN_SELECTOR: 'UNKNOWN_SELECTOR',
  MALFORMED_CALLDATA: 'MALFORMED_CALLDATA',
  ARGUMENTS_UNDECODABLE: 'ARGUMENTS_UNDECODABLE',
});

/** Which level each finding forces on its own. */
export const FINDING_LEVEL = Object.freeze({
  [Finding.ACTION_MISMATCH]: Level.BLOCK,
  [Finding.TOKEN_MISMATCH]: Level.BLOCK,
  [Finding.RECIPIENT_MISMATCH]: Level.BLOCK,
  [Finding.SPENDER_MISMATCH]: Level.BLOCK,
  [Finding.AMOUNT_EXCEEDS_INTENT]: Level.BLOCK,
  [Finding.CHAIN_MISMATCH]: Level.BLOCK,
  [Finding.NATIVE_VALUE_UNDECLARED]: Level.BLOCK,

  [Finding.UNBOUNDED_APPROVAL]: Level.BLOCK,
  [Finding.APPROVAL_FOR_ALL]: Level.BLOCK,
  [Finding.OWNERSHIP_TRANSFER]: Level.BLOCK,
  [Finding.PROXY_UPGRADE]: Level.BLOCK,
  [Finding.SELF_DESTRUCT]: Level.BLOCK,

  [Finding.UNKNOWN_SELECTOR]: Level.REFUSE,
  [Finding.MALFORMED_CALLDATA]: Level.REFUSE,
  [Finding.ARGUMENTS_UNDECODABLE]: Level.REFUSE,
});

/** Human-readable reason per finding, used in the Ledger prompt and the log. */
export const FINDING_TEXT = Object.freeze({
  [Finding.ACTION_MISMATCH]: 'the calldata performs a different kind of action than the one declared',
  [Finding.TOKEN_MISMATCH]: 'the token being moved is not the token that was declared',
  [Finding.RECIPIENT_MISMATCH]: 'the funds go to an address other than the declared recipient',
  [Finding.SPENDER_MISMATCH]: 'approval is granted to an address other than the declared spender',
  [Finding.AMOUNT_EXCEEDS_INTENT]: 'the amount in the calldata is larger than the amount declared',
  [Finding.CHAIN_MISMATCH]: 'the transaction targets a different chain than the one declared',
  [Finding.NATIVE_VALUE_UNDECLARED]: 'the transaction sends native currency that was never declared',
  [Finding.UNBOUNDED_APPROVAL]: 'the approval is unlimited where a specific amount was declared',
  [Finding.APPROVAL_FOR_ALL]: 'the call grants blanket control over an entire token collection',
  [Finding.OWNERSHIP_TRANSFER]: 'the call transfers ownership of a contract',
  [Finding.PROXY_UPGRADE]: 'the call changes the implementation behind a proxy',
  [Finding.SELF_DESTRUCT]: 'the call destroys a contract',
  [Finding.UNKNOWN_SELECTOR]: 'the function being called could not be identified, so the effect is unknown',
  [Finding.MALFORMED_CALLDATA]: 'the calldata is not well formed and cannot be read',
  [Finding.ARGUMENTS_UNDECODABLE]: 'the function was identified but its arguments could not be read',
});

/** Actions that can never be undone once mined, regardless of intent match. */
export const IRREVERSIBLE = new Set([
  Finding.UNBOUNDED_APPROVAL,
  Finding.APPROVAL_FOR_ALL,
  Finding.OWNERSHIP_TRANSFER,
  Finding.PROXY_UPGRADE,
  Finding.SELF_DESTRUCT,
]);
