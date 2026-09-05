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

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class Gate {
  /**
   * @param {object}  [deps]
   * @param {object}  [deps.rpc]       simulation transport; omit to skip simulation
   * @param {object}  [deps.confirm]   confirmation port, see LedgerPort below
   * @param {object}  [deps.recorder]  on-chain recorder, optional
   * @param {number}  [deps.ttlMs]     how long an approval stays valid
   * @param {() => number} [deps.now]  injectable clock, for tests
   */
  constructor(deps = {}) {
    this.rpc = deps.rpc ?? null;
    this.confirm = deps.confirm ?? null;
    this.recorder = deps.recorder ?? null;
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    this.now = deps.now ?? (() => Date.now());
    /** @type {Map<string, {approver:string, at:number, used:boolean}>} */
    this.approvals = new Map();
  }

  /**
   * Run every available check against a declared intent and a transaction.
   * Returns the combined verdict; does not send anything anywhere.
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

    const level = worst(levels);
    return {
      level,
      findings,
      deed: stat.deed,
      deltas,
      irreversible: stat.irreversible,
      deedHash: hashDeed(tx),
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
    const approver = await this.confirm.request({
      deedHash: result.deedHash,
      level: result.level,
      findings: result.findings,
      deed: result.deed,
    });
    if (!approver) return false;
    this.approvals.set(result.deedHash, { approver, at: this.now(), used: false });
    return true;
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

  /** Shape a result for the on-chain recorder. */
  toRecord(result) {
    return {
      intentHash: result.intentHash,
      deedHash: result.deedHash,
      level: LEVEL_CODE[result.level],
      findings: encodeFindings(result.findings),
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
      return sig ? address : null;
    } catch (err) {
      // A refusal on the device and a broken cable both land here and they are
      // not the same event. Neither approves anything, so both return null,
      // but the caller is told which happened rather than being left to guess.
      const denied = /denied|rejected|0x6985/i.test(String(err.message ?? err));
      this.lastError = denied ? 'declined on device' : `device error: ${err.message ?? err}`;
      return null;
    }
  }
}
