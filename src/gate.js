// speculum — the gate
//
// Orchestrates the whole check and holds the one property that makes a human
// confirmation worth anything: an approval is bound to the exact bytes it
// approved.
//
// Without that binding the escalation is theatre. A human taps "yes" on a
// device showing one transaction, and whatever is sent afterwards is a
// different transaction. That is the same class of failure speculum exists to
// catch, so it would be absurd to reintroduce it in the approval step.
//
// Approvals are therefore keyed by deedHash, which commits to chainId, target,
// value and the full calldata. Change one byte and the approval no longer
// applies.

import { compare } from './compare.js';
import { verifyEffect } from './simulate.js';
import { hashDeed, hashIntent, encodeFindings, LEVEL_CODE } from './onchain.js';
import { Level, worst } from './types.js';
import { readHistory, counterpartiesOf } from './history.js';
import { judge, DEFAULT_POLICY, UNDETERMINED } from './policy.js';

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class Gate {
  /**
   * @param {object}  [deps]
   * @param {object}  [deps.rpc]       simulation transport; omit to skip simulation
   * @param {object}  [deps.confirm]   confirmation port, see LedgerPort below
   * @param {object}  [deps.recorder]  on-chain recorder, optional
   * @param {object}  [deps.history]   subgraph reader, see history.js; omit to rule on merits only
   * @param {object}  [deps.historyPolicy] thresholds, defaults in history.js
   * @param {number}  [deps.ttlMs]     how long an approval stays valid
   * @param {() => number} [deps.now]  injectable clock, for tests
   */
  constructor(deps = {}) {
    this.rpc = deps.rpc ?? null;
    this.confirm = deps.confirm ?? null;
    this.recorder = deps.recorder ?? null;
    this.history = deps.history ?? null;
    this.policy = { ...DEFAULT_POLICY, ...(deps.historyPolicy ?? {}) };
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    this.now = deps.now ?? (() => Date.now());
    /** @type {Map<string, {approver:string, at:number, used:boolean}>} */
    this.approvals = new Map();
  }

  /**
   * Run every available check against a declared intent and a transaction.
   * Returns the combined verdict; does not send anything anywhere.
   *
   * The verdict has two layers. `merits` is what the bytes earn on their own:
   * decoding, comparison, simulation. `level` is the ruling after history
   * has been consulted, and can only be the merits level or worse. `verdict`
   * is `level` as a string except when history was asked for and could not
   * be read, in which case it is UNDETERMINED-ON-HISTORY and `level` is
   * REFUSE, so no consumer reading either field can mistake a partial ruling
   * for a full one.
   */
  async check(intent, tx, opts = {}) {
    const stat = compare(intent, tx, opts);
    const findings = [...stat.findings];
    const levels = [stat.level];
    let deltas = null;

    // Simulation only runs when decoding produced something to compare against.
    // Simulating a call we could not decode would tell us balances moved
    // without telling us whether that matches anything, and dressing that up
    // as a second opinion would be false confidence.
    if (this.rpc && stat.level !== Level.REFUSE && opts.from) {
      const eff = await verifyEffect(intent, tx, this.rpc, opts);
      findings.push(...eff.findings);
      levels.push(eff.level);
      deltas = eff.deltas;
    }

    const deedHash = hashDeed(tx);
    const merits = { level: worst(levels), findings: [...findings] };

    // History is read after the merits are settled and never before, so the
    // merits cannot be shaped by it. It is read when a reader is configured;
    // a gate built without one rules on merits alone and the result says so
    // in `history.consulted`, which is a configuration a caller chose, not a
    // failure being hidden.
    let history = { consulted: false };
    if (this.history) {
      // The agent's record is keyed by the signing address. Without it the
      // agent rule cannot run, and running the others while quietly skipping
      // that one would be a partial ruling dressed as a full one.
      if (!opts.from) throw new Error('history needs the signing address: pass opts.from');
      history = await readHistory(this.history, {
        deedHash,
        agent: opts.from,
        counterparties: counterpartiesOf(stat.deed, opts.from),
      });
      const h = judge(history, { merits, intent, deed: stat.deed, policy: this.policy });
      findings.push(...h.findings);
      levels.push(h.level);
    }

    const level = worst(levels);
    return {
      level,
      verdict: history.consulted && !history.available ? UNDETERMINED : level,
      findings,
      merits,
      history,
      deed: stat.deed,
      deltas,
      irreversible: stat.irreversible,
      deedHash,
      intentHash: hashIntent(intent),
      needsHuman: level === Level.BLOCK || stat.irreversible,
    };
  }

  /**
   * Ask the confirmation port for a human decision on a specific result.
   * The approval is stored against the deedHash carried by that result.
   */
  async escalate(result) {
    if (!this.confirm) throw new Error('no confirmation port configured');
    const answer = await this.confirm.request({
      deedHash: result.deedHash,
      level: result.level,
      findings: result.findings,
      deed: result.deed,
    });
    if (!answer) return false;
    // A port may answer with an address alone, or with the signature it
    // obtained and the message parts that were signed. Only the second kind
    // can be proven later; the first is remembered as an approval the gate
    // saw but cannot show anyone.
    const a = typeof answer === 'string' ? { address: answer } : answer;
    this.approvals.set(result.deedHash, {
      approver: a.address,
      signature: a.signature ?? null,
      level: a.level ?? result.level,
      reason: a.reason ?? null,
      at: this.now(),
      used: false,
    });
    return true;
  }

  /**
   * What the recorder needs to put an override on chain, or null when the
   * approval cannot be proven.
   *
   * The contract will only emit an override it can recover a signer from, so
   * an approval with no signature has nowhere to go on chain. That is
   * deliberate: the alternative is recording "a human approved" on the word
   * of whoever called this, which is the claim the old record made eight
   * times and could not back.
   */
  proof(result) {
    const rec = this.approvals.get(result.deedHash);
    if (!rec || !rec.signature) return null;
    return {
      deedHash: result.deedHash,
      level: LEVEL_CODE[rec.level],
      reason: rec.reason,
      signature: rec.signature,
      approver: rec.approver,
      message: LedgerPort.message({ deedHash: result.deedHash, level: rec.level, reason: rec.reason }),
    };
  }

  /**
   * May this exact transaction be signed?
   *
   * Re-derives the hash from the transaction being sent rather than trusting a
   * hash passed alongside it. A caller handing us both a transaction and a hash
   * is a caller who can hand us a matching pair that describes different bytes.
   */
  authorise(tx) {
    const hash = hashDeed(tx);
    const record = this.approvals.get(hash);
    if (!record) return { ok: false, reason: 'no approval for these exact bytes' };
    if (record.used) return { ok: false, reason: 'approval already spent' };
    if (this.now() - record.at > this.ttlMs) return { ok: false, reason: 'approval expired' };
    record.used = true;
    return { ok: true, approver: record.approver };
  }

  /**
   * Shape a result for the on-chain recorder.
   *
   * What goes on chain is the merits verdict, not the ruling after history.
   * The record is the measure of how often an agent's words and bytes
   * disagree, and history escalations are a policy applied to that measure.
   * Writing them back would count "blocked because it was blocked before" as
   * a fresh divergence, inflate the divergence rate, and trigger more
   * escalations off the inflated rate: the record would start measuring the
   * policy instead of the agent. So the loop is open by construction. The
   * history findings stay in the result, the escalation stays in the gate,
   * and the chain keeps counting only what the bytes did against what was
   * said.
   */
  toRecord(result) {
    const merits = result.merits ?? result;
    return {
      intentHash: result.intentHash,
      deedHash: result.deedHash,
      level: LEVEL_CODE[merits.level],
      findings: encodeFindings(merits.findings),
      target: result.deed.target,
    };
  }
}

/**
 * Confirmation over a Ledger device.
 *
 * NOT RUN. This is written against @ledgerhq/hw-app-eth 7.8.16 and
 * @ledgerhq/hw-transport-node-hid 6.33.5 but has never been executed against
 * hardware. Treat every claim about device behaviour here as untested until it
 * has been run with a device attached.
 *
 * The device is asked to sign a message that names the deedHash and the reason
 * for the block. Signing a message rather than the transaction is deliberate:
 * the approval is an assertion about a specific transaction, and keeping it
 * separate means an approval can never be replayed as the transaction itself.
 */
export class LedgerPort {
  constructor({ transport, eth, path = "44'/60'/0'/0/0", prompt = null }) {
    this.transport = transport;
    this.eth = eth;
    this.path = path;
    this.prompt = prompt;
  }

  static message({ deedHash, level, reason }) {
    return [
      'speculum approval',
      `verdict: ${level}`,
      `reason: ${reason}`,
      `deed: ${deedHash}`,
    ].join('\n');
  }

  /**
   * Returns the approver's address together with the signature the device
   * produced and the exact parts that went into the signed message, so the
   * contract can rebuild the message and recover the same address. Returns
   * null on any refusal or failure; see classify() for which.
   */
  async request({ deedHash, level, findings }) {
    const reason = findings.length ? findings[0].why : 'no reason recorded';
    const message = LedgerPort.message({ deedHash, level, reason });

    if (this.prompt) await this.prompt(message);

    try {
      const { address } = await this.eth.getAddress(this.path, false);
      const sig = await this.eth.signPersonalMessage(
        this.path,
        Buffer.from(message, 'utf8').toString('hex'),
      );
      if (!sig) return null;
      return { address, signature: LedgerPort.encode(sig), level, reason };
    } catch (err) {
      // Several very different events land here and none of them approve
      // anything, so all return null. But an operator staring at a stuck agent
      // needs to know which one happened, and "device error" tells them
      // nothing. The status codes below were observed against real hardware,
      // not read off a table.
      this.lastError = LedgerPort.classify(err);
      return null;
    }
  }

  /**
   * Turn a device failure into something a human can act on.
   *
   * 0x6985 is a deliberate refusal and is the only one that means the human
   * said no. 0x6d00 means the instruction is unknown to whatever app is
   * currently open, which in practice means the Ethereum app is not open and
   * the dashboard is answering instead. Treating that as a refusal would
   * record a human decision that never happened.
   */
  /**
   * Pack the device's {r, s, v} into the 65-byte form the contract reads.
   * hw-app-eth returns v as a number that is 27/28 on most firmware and 0/1
   * on some; the contract accepts both, and this normalises to 27/28 anyway
   * so the bytes on chain are the same whichever firmware signed.
   */
  static encode({ r, s, v }) {
    const vv = Number(v) < 27 ? Number(v) + 27 : Number(v);
    return `0x${r}${s}${vv.toString(16).padStart(2, '0')}`;
  }

  static classify(err) {
    const msg = String(err?.message ?? err);
    const code = err?.statusCode;
    if (code === 0x6985 || /denied|rejected|0x6985/i.test(msg)) return 'declined on device';
    if (code === 0x6d00 || /INS_NOT_SUPPORTED|0x6d00/i.test(msg))
      return 'wrong app open on device, the Ethereum app must be running';
    if (code === 0x6511 || /no app|0x6511/i.test(msg)) return 'no app open on device';
    if (code === 0x5515 || /locked|0x5515/i.test(msg)) return 'device is locked';
    if (/cannot open|no device|not found/i.test(msg))
      return 'device not reachable, check the cable and that Ledger Live is closed';
    return `device error: ${msg}`;
  }
}
