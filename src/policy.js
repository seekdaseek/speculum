// speculum — policy
//
// The rules the gate applies to what history.js read. Kept apart from the
// reader for the same reason the decoder is kept apart from the intent: the
// code that fetches the record has no opinion about it, and the code with
// opinions cannot reach the network.
//
// Every rule here either raises a finding or does nothing. There is no rule
// that lowers a verdict and, with the level table below, no way to write one.

import { Level, worst } from './types.js';

/** Findings the history layer can raise. None of them maps to PASS. */
export const HistoryFinding = Object.freeze({
  HISTORY_REPEAT_OF_BLOCKED_DEED: 'HISTORY_REPEAT_OF_BLOCKED_DEED',
  HISTORY_AGENT_DIVERGENT: 'HISTORY_AGENT_DIVERGENT',
  HISTORY_COUNTERPARTY_BLOCKED: 'HISTORY_COUNTERPARTY_BLOCKED',
  HISTORY_UNAVAILABLE: 'HISTORY_UNAVAILABLE',
});

/**
 * The level each history finding forces. There is deliberately no PASS in
 * this table: the invariant that history never softens is enforced by there
 * being nothing here that could. A test asserts the table stays that way.
 */
export const HISTORY_LEVEL = Object.freeze({
  [HistoryFinding.HISTORY_REPEAT_OF_BLOCKED_DEED]: Level.BLOCK,
  [HistoryFinding.HISTORY_AGENT_DIVERGENT]: Level.BLOCK,
  [HistoryFinding.HISTORY_COUNTERPARTY_BLOCKED]: Level.BLOCK,
  [HistoryFinding.HISTORY_UNAVAILABLE]: Level.REFUSE,
});

export const HISTORY_TEXT = Object.freeze({
  [HistoryFinding.HISTORY_REPEAT_OF_BLOCKED_DEED]:
    'these exact bytes were blocked before; a matching declaration now does not undo that',
  [HistoryFinding.HISTORY_AGENT_DIVERGENT]:
    'this agent has diverged too often to be given the benefit of the doubt on an underspecified pass',
  [HistoryFinding.HISTORY_COUNTERPARTY_BLOCKED]:
    'the recipient or spender appears in the record of blocked checks',
  [HistoryFinding.HISTORY_UNAVAILABLE]:
    'the verdict record could not be read, so this ruling is undetermined on history',
});

/** What a result reports as its verdict when history was asked for and not readable. */
export const UNDETERMINED = 'UNDETERMINED-ON-HISTORY';

/**
 * Thresholds. Stated here, once, with the reason for each, because a
 * threshold with no stated reason is a magic number that gets tuned until
 * the demo looks good.
 *
 * divergenceThreshold 0.5: an agent whose declarations have been wrong more
 * often than right has forfeited the benefit of the doubt. Below that the
 * record is noise from a few bad calls; above it the record is the agent.
 *
 * minChecks 5: a rate needs a denominator. One blocked check is a rate of
 * 1.0 and means nothing. Five is small enough that a misbehaving agent is
 * caught within its first session and large enough that a single mistake is
 * not a permanent brand.
 */
export const DEFAULT_POLICY = Object.freeze({
  divergenceThreshold: 0.5,
  minChecks: 5,
});

/**
 * Is a merits PASS a strong pass or a weak one?
 *
 * The comparator only checks fields the intent declares. An intent that
 * omits the recipient cannot mismatch on the recipient. So a PASS on a sparse
 * intent means "nothing claimed was wrong", which is weaker than "everything
 * the bytes do was claimed and matched". The same goes for a pass that used
 * tolerance slack, and for a batch, which has more surface than one call.
 *
 * These are the passes an agent with a bad record does not get for free.
 *
 * @returns {string[]} the reasons this pass is borderline; empty means it is not
 */
export function borderline(intent, deed) {
  const reasons = [];
  const leaves = deed.legs ? [...leafLegs(deed)] : [deed];

  const has = (k) => leaves.some((d) => d[k] != null && d[k] !== 'native');
  if (intent.action == null) reasons.push('action undeclared');
  if (intent.chainId == null) reasons.push('chain undeclared');
  if (intent.token == null && has('asset')) reasons.push('token undeclared');
  if (intent.recipient == null && has('recipient')) reasons.push('recipient undeclared');
  if (intent.spender == null && has('spender')) reasons.push('spender undeclared');
  if (intent.amount == null && has('amount')) reasons.push('amount undeclared');
  if (intent.amount != null && !deed.legs && deed.amount != null && deed.amount > BigInt(intent.amount)) {
    reasons.push('passed on tolerance');
  }
  if (deed.legs) reasons.push('batch');
  return reasons;
}

function* leafLegs(deed) {
  for (const leg of deed.legs ?? []) {
    if (leg.legs) yield* leafLegs(leg);
    else yield leg;
  }
}

/**
 * Apply the rules. Each one either raises a finding or does nothing; there is
 * no rule that lowers anything, and no way to write one with the tables above.
 *
 * Rule 1, repeat of a blocked deed. If these exact bytes were ever blocked or
 * refused, they are escalated now, whatever the current declaration says.
 * The record already holds a case of byte-identical calldata judged PASS
 * under one declaration and BLOCK under another. Once bytes have been
 * presented under a false description, their reappearance under a matching
 * one is the "rewrite the intent to fit the calldata" move that on-chain
 * declaration ordering exists to catch, and a human should see it. A prior
 * override is reported but does not soften: it approved one moment, not the
 * bytes forever.
 *
 * Rule 2, divergent agent. An agent past the divergence threshold, with
 * enough checks for the rate to mean something, loses the benefit of the
 * doubt on borderline passes. A full-field pass still passes: the record
 * says the agent lies, not that verified bytes are wrong. What it takes away
 * is the pass that rests on the agent having claimed nothing.
 *
 * Rule 3, counterparty in the blocked record. Value about to go to, or
 * allowance about to be granted to, an address that appears in a blocked
 * check is escalated. The on-chain event carries two address roles, the
 * signing agent and the call target, and the address is matched against
 * both; the role is named in the detail. The recipient and spender of past
 * checks are not on chain, so "appeared as a recipient before" is not
 * answerable from this contract. One human tap is cheap against an
 * irreversible transfer to an address the record already knows.
 *
 * Rule 4, unreadable record. A refusal, and the result is marked
 * UNDETERMINED-ON-HISTORY so nobody mistakes it for a full verdict.
 */
export function judge(history, { merits, intent, deed, policy = DEFAULT_POLICY }) {
  const findings = [];
  const add = (code, detail) =>
    findings.push({ code, level: HISTORY_LEVEL[code], why: HISTORY_TEXT[code], detail });

  if (!history.available) {
    add(HistoryFinding.HISTORY_UNAVAILABLE, history.reason);
    return { level: Level.REFUSE, findings };
  }

  // Rule 1
  if (history.deed.everNotPassed) {
    const d = history.deed;
    add(HistoryFinding.HISTORY_REPEAT_OF_BLOCKED_DEED,
      `judged ${d.prior} time(s) before: ${d.passed} passed, ${d.blocked} blocked, ${d.refused} refused` +
      (d.overrides ? `, ${d.overrides} human override(s), which do not carry forward` : ''));
  }

  // Rule 2
  const a = history.agent;
  if (a.known && a.checks >= policy.minChecks && a.divergenceRate > policy.divergenceThreshold
      && merits.level === Level.PASS) {
    const weak = borderline(intent, deed);
    if (weak.length) {
      add(HistoryFinding.HISTORY_AGENT_DIVERGENT,
        `agent diverged on ${a.blocked + a.refused} of ${a.checks} checks (rate ${a.divergenceRate.toFixed(2)}, ` +
        `threshold ${policy.divergenceThreshold}); this pass rests on: ${weak.join(', ')}`);
    }
  }

  // Rule 3
  for (const [addr, p] of Object.entries(history.parties)) {
    if (!p.asAgentBlocked && !p.asTargetBlocked) continue;
    const roles = [];
    if (p.asAgentBlocked) roles.push(`as a signer blocked ${p.asAgentBlocked} time(s)`);
    if (p.asTargetBlocked) roles.push(`as the target of ${p.asTargetBlocked} blocked check(s) [${p.findings.join(', ')}]`);
    add(HistoryFinding.HISTORY_COUNTERPARTY_BLOCKED, `${addr} appears ${roles.join(' and ')}`);
  }

  return { level: worst(findings.map((f) => f.level)), findings };
}
