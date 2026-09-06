// speculum — subgraph mappings
//
// The bit order here must match src/onchain.js exactly. It is duplicated
// rather than imported because AssemblyScript cannot read the JavaScript
// module, and a comment is the only thing holding the two in sync. If a bit is
// ever appended on one side and not the other, every event indexed afterwards
// is mislabelled and nothing fails loudly. Append only, never reorder.

import { BigInt, BigDecimal, Bytes, Address, ethereum } from '@graphprotocol/graph-ts';
import { Checked, Declared, Overridden } from '../generated/Speculum/Speculum';
import { Agent, Check, Declaration, Override, Totals, FindingCount, DeedIndex, IntentIndex } from '../generated/schema';

const FINDINGS: string[] = [
  'ACTION_MISMATCH',          // 0
  'TOKEN_MISMATCH',           // 1
  'RECIPIENT_MISMATCH',       // 2
  'SPENDER_MISMATCH',         // 3
  'AMOUNT_EXCEEDS_INTENT',    // 4
  'CHAIN_MISMATCH',           // 5
  'NATIVE_VALUE_UNDECLARED',  // 6
  'UNBOUNDED_APPROVAL',       // 7
  'APPROVAL_FOR_ALL',         // 8
  'OWNERSHIP_TRANSFER',       // 9
  'PROXY_UPGRADE',            // 10
  'SELF_DESTRUCT',            // 11
  'UNKNOWN_SELECTOR',         // 12
  'MALFORMED_CALLDATA',       // 13
  'ARGUMENTS_UNDECODABLE',    // 14
];

// Mirrors IRREVERSIBLE in src/types.js.
const IRREVERSIBLE_BITS: i32[] = [7, 8, 9, 10, 11];

const LEVELS: string[] = ['PASS', 'BLOCK', 'REFUSE'];
const TOTALS_ID = Bytes.fromUTF8('totals');
const ONE = BigInt.fromI32(1);

function decodeFindings(bits: i32): string[] {
  const out: string[] = [];
  for (let i = 0; i < FINDINGS.length; i++) {
    if ((bits >> i) & 1) out.push(FINDINGS[i]);
  }
  return out;
}

function isIrreversible(bits: i32): boolean {
  for (let i = 0; i < IRREVERSIBLE_BITS.length; i++) {
    if ((bits >> IRREVERSIBLE_BITS[i]) & 1) return true;
  }
  return false;
}

function bumpFindingCounts(bits: i32): void {
  for (let i = 0; i < FINDINGS.length; i++) {
    if (((bits >> i) & 1) == 0) continue;
    let fc = FindingCount.load(FINDINGS[i]);
    if (fc == null) {
      fc = new FindingCount(FINDINGS[i]);
      fc.bit = i;
      fc.count = BigInt.zero();
      fc.irreversible = IRREVERSIBLE_BITS.includes(i);
    }
    fc.count = fc.count.plus(ONE);
    fc.save();
  }
}

function loadTotals(): Totals {
  let t = Totals.load(TOTALS_ID);
  if (t == null) {
    t = new Totals(TOTALS_ID);
    t.checks = BigInt.zero();
    t.passed = BigInt.zero();
    t.blocked = BigInt.zero();
    t.refused = BigInt.zero();
    t.overrides = BigInt.zero();
    t.uncheckedOverrides = BigInt.zero();
    t.agents = BigInt.zero();
  }
  return t as Totals;
}

function loadAgent(addr: Address, ts: BigInt): Agent {
  let a = Agent.load(addr);
  if (a == null) {
    a = new Agent(addr);
    a.firstSeen = ts;
    a.checks = BigInt.zero();
    a.passed = BigInt.zero();
    a.blocked = BigInt.zero();
    a.refused = BigInt.zero();
    a.divergenceRate = BigDecimal.zero();
    a.overridden = BigInt.zero();
    a.declarations = BigInt.zero();
    a.undeclared = BigInt.zero();

    const t = loadTotals();
    t.agents = t.agents.plus(ONE);
    t.save();
  }
  a.lastSeen = ts;
  return a as Agent;
}

/** Blocked plus refused over total checks. Zero checks is zero, not a divide by zero. */
function recomputeRate(a: Agent): void {
  if (a.checks.equals(BigInt.zero())) {
    a.divergenceRate = BigDecimal.zero();
    return;
  }
  a.divergenceRate = a.blocked.plus(a.refused).toBigDecimal().div(a.checks.toBigDecimal());
}

function eventId(event: ethereum.Event): Bytes {
  return event.transaction.hash.concatI32(event.logIndex.toI32());
}

export function handleChecked(event: Checked): void {
  const ts = event.block.timestamp;
  const agent = loadAgent(event.params.agent, ts);

  // findings is uint32 on the wire, which graph-ts hands over as BigInt.
  // Converting once here keeps every helper below working in plain i32, and
  // the bitfield only ever uses 15 of those bits so the narrowing is safe.
  const bits = event.params.findings.toI32();
  const levelCode = event.params.level;
  const level = levelCode < LEVELS.length ? LEVELS[levelCode] : 'UNKNOWN';

  const c = new Check(eventId(event));
  c.agent = agent.id;
  c.intentHash = event.params.intentHash;
  c.deedHash = event.params.deedHash;
  c.target = event.params.target;
  c.level = level;
  c.levelCode = levelCode;
  c.findings = decodeFindings(bits);
  c.findingBits = bits;
  c.irreversible = isIrreversible(bits);

  // An intent declared only after the calldata exists proves nothing. Earlier
  // this asked the weaker question, whether the agent had ever declared
  // anything at all, because there was no index from intent hash to
  // declaration. There is one now, so it asks the question that actually
  // matters: was THIS intent declared, and was it declared before this check.
  const declared = IntentIndex.load(event.params.intentHash);
  c.declaredFirst = declared != null && declared.declaredAtBlock.le(event.block.number);
  if (!c.declaredFirst) agent.undeclared = agent.undeclared.plus(ONE);

  c.blockNumber = event.block.number;
  c.timestamp = ts;
  c.txHash = event.transaction.hash;
  c.save();

  // Index the deed so a later override can be tied to this verdict. A deed
  // checked twice keeps the latest verdict, which is the honest answer: the
  // most recent judgement is the one a human would have been shown.
  let di = DeedIndex.load(event.params.deedHash);
  if (di == null) di = new DeedIndex(event.params.deedHash);
  di.check = c.id;
  di.agent = agent.id;
  di.save();

  agent.checks = agent.checks.plus(ONE);
  const t = loadTotals();
  t.checks = t.checks.plus(ONE);

  if (level == 'PASS') {
    agent.passed = agent.passed.plus(ONE);
    t.passed = t.passed.plus(ONE);
  } else if (level == 'BLOCK') {
    agent.blocked = agent.blocked.plus(ONE);
    t.blocked = t.blocked.plus(ONE);
  } else if (level == 'REFUSE') {
    agent.refused = agent.refused.plus(ONE);
    t.refused = t.refused.plus(ONE);
  }

  recomputeRate(agent);
  agent.save();
  t.save();

  bumpFindingCounts(bits);
}

export function handleDeclared(event: Declared): void {
  const agent = loadAgent(event.params.agent, event.block.timestamp);
  agent.declarations = agent.declarations.plus(ONE);
  agent.save();

  // Keep the EARLIEST declaration of an intent hash. Re-declaring the same
  // intent later must not be able to make an already-judged check look as
  // though it had been declared up front.
  let ii = IntentIndex.load(event.params.intentHash);
  if (ii == null) {
    ii = new IntentIndex(event.params.intentHash);
    ii.declaredAtBlock = event.block.number;
    ii.agent = agent.id;
    ii.save();
  }

  const d = new Declaration(eventId(event));
  d.agent = agent.id;
  d.intentHash = event.params.intentHash;
  d.nonce = event.params.nonce;
  d.blockNumber = event.block.number;
  d.timestamp = event.block.timestamp;
  d.save();
}

export function handleOverridden(event: Overridden): void {
  const o = new Override(eventId(event));
  o.deedHash = event.params.deedHash;
  o.approver = event.params.approver;
  o.blockNumber = event.block.number;
  o.timestamp = event.block.timestamp;

  const t = loadTotals();
  t.overrides = t.overrides.plus(ONE);

  // Resolve the verdict this override answers. When there is no matching
  // check, a human approved a deed the gate never saw, which means something
  // reached a signer around the gate. That is the finding worth surfacing, and
  // it is only meaningful because the ordinary case now resolves.
  const di = DeedIndex.load(event.params.deedHash);
  if (di == null) {
    o.check = null;
    o.unchecked = true;
    t.uncheckedOverrides = t.uncheckedOverrides.plus(ONE);
  } else {
    o.check = di.check;
    o.unchecked = false;

    const agent = Agent.load(di.agent);
    if (agent != null) {
      agent.overridden = agent.overridden.plus(ONE);
      agent.lastSeen = event.block.timestamp;
      agent.save();
    }
  }

  t.save();
  o.save();
}
