// speculum — audit trail on Hedera Consensus Service
//
// Every paid verdict is written to an HCS topic: the hash of what the agent
// declared, the hash of what it was about to sign, the verdict, and the
// settlement that paid for it. That is the same claim the project makes on
// Base through the contract and the subgraph, made here on the chain the
// payment happened on, so someone who was not there can check both halves
// against public mirror nodes with no key and no account.
//
// The record is deliberately small. Hashes rather than the intent and the
// bytes themselves: the bytes may be private, and a hash is enough to prove
// a later claim about them was the same claim. One chunk, so the mirror node
// shows one message per verdict rather than a reassembly.

import {
  Client, AccountId, PrivateKey, TopicId,
  TopicCreateTransaction, TopicMessageSubmitTransaction,
} from '@hiero-ledger/sdk';
import { outcomeOf } from './verdict.js';

/** One HCS chunk. A record over this would be split and shown as several. */
export const RECORD_LIMIT = 1024;

export const MIRROR = Object.freeze({
  testnet: 'https://testnet.mirrornode.hedera.com',
  mainnet: 'https://mainnet.mirrornode.hedera.com',
});

/**
 * Build the record for one paid verdict. Refuses to build one without a
 * settlement: an audit entry that says a verdict was sold with nothing to
 * show for the sale is the kind of record this project exists to catch.
 */
export function auditRecord({ intentHash, deedHash, level, findings, tier, paid, network = 'hedera:testnet' }) {
  if (!paid?.settlement) throw new Error('a record needs the settlement it was paid by');
  return {
    v: 1,
    service: 'speculum',
    network,
    intentHash,
    deedHash,
    verdict: level,
    outcome: outcomeOf(level),
    findings: (findings ?? []).map((f) => f.code ?? f),
    tier,
    paid: {
      settlement: paid.settlement,
      payer: paid.payer ?? null,
      payTo: paid.payTo,
      amount: String(paid.amount),
      asset: paid.asset,
    },
  };
}

export function encodeRecord(rec) {
  const s = JSON.stringify(rec);
  const n = Buffer.byteLength(s, 'utf8');
  if (n > RECORD_LIMIT) throw new Error(`record is ${n} bytes, over the ${RECORD_LIMIT} byte chunk`);
  return s;
}

/**
 * The mirror node returns messages base64 encoded. Anything on the topic
 * that is not a speculum record, including well-formed JSON that merely
 * happens to be there, is refused rather than read as one.
 */
export function decodeRecord(base64) {
  const rec = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  if (!isRecord(rec)) throw new Error('not a speculum record');
  return rec;
}

export function isRecord(r) {
  const hash = (h) => typeof h === 'string' && /^0x[0-9a-f]{64}$/i.test(h);
  return Boolean(
    r && typeof r === 'object' && r.v === 1 && r.service === 'speculum' &&
    hash(r.intentHash) && hash(r.deedHash) &&
    typeof r.verdict === 'string' && typeof r.outcome === 'string' &&
    Array.isArray(r.findings) && r.findings.every((f) => typeof f === 'string') &&
    r.paid && typeof r.paid.settlement === 'string' && typeof r.paid.payTo === 'string' &&
    typeof r.paid.amount === 'string',
  );
}

/** `0.0.7162784@1788674101.284043818` as the mirror node's REST path form. */
export function mirrorTxPath(settlement) {
  const [account, ts] = String(settlement).split('@');
  if (!account || !ts) throw new Error(`not a settlement id: ${settlement}`);
  return `${account}-${ts.replace('.', '-')}`;
}

export function mirrorMessageUrl(network, topicId, sequenceNumber) {
  return `${MIRROR[network]}/api/v1/topics/${topicId}/messages/${sequenceNumber}`;
}

function clientFor(network, operatorId, operatorKey) {
  const client = network === 'mainnet' ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(AccountId.fromString(operatorId), PrivateKey.fromStringECDSA(operatorKey));
  return client;
}

/** Create the topic once. Returns its id; the caller keeps it in the env. */
export async function createTopic({ operatorId, operatorKey, network = 'testnet', memo = 'speculum verdicts' }) {
  const client = clientFor(network, operatorId, operatorKey);
  try {
    const tx = await new TopicCreateTransaction().setTopicMemo(memo).execute(client);
    const receipt = await tx.getReceipt(client);
    return { topicId: receipt.topicId.toString(), transactionId: tx.transactionId.toString(), status: receipt.status.toString() };
  } finally {
    client.close();
  }
}

/** Writes records to one topic on behalf of one operator. */
export class HcsAudit {
  constructor({ operatorId, operatorKey, topicId, network = 'testnet' }) {
    if (!operatorId || !operatorKey || !topicId) throw new Error('HcsAudit needs operatorId, operatorKey and topicId');
    this.network = network;
    this.topicId = TopicId.fromString(topicId).toString();
    this.client = clientFor(network, operatorId, operatorKey);
  }

  /**
   * Submit one record and wait for the receipt, so the sequence number the
   * caller gets back is the one the network assigned, not a guess.
   */
  async write(rec) {
    const message = encodeRecord(rec);
    const tx = await new TopicMessageSubmitTransaction({ topicId: this.topicId, message }).execute(this.client);
    const receipt = await tx.getReceipt(this.client);
    const sequenceNumber = receipt.topicSequenceNumber?.toString() ?? null;
    return {
      topicId: this.topicId,
      sequenceNumber,
      transactionId: tx.transactionId.toString(),
      status: receipt.status.toString(),
      verify: sequenceNumber ? mirrorMessageUrl(this.network, this.topicId, sequenceNumber) : null,
    };
  }

  close() {
    this.client.close();
  }
}

/**
 * Read a topic back from the mirror node, oldest first, decoded. No key.
 * Follows the mirror node's own paging links until there are no more.
 */
export async function readTopic(topicId, { network = 'testnet', limit = 100, fetchImpl = fetch } = {}) {
  const base = MIRROR[network];
  let url = `${base}/api/v1/topics/${topicId}/messages?limit=${Math.min(limit, 100)}&order=asc`;
  const out = [];
  while (url && out.length < limit) {
    const r = await fetchImpl(url);
    if (!r.ok) throw new Error(`mirror node ${r.status} for ${url}`);
    const j = await r.json();
    for (const m of j.messages ?? []) {
      let record = null, error = null;
      try { record = decodeRecord(m.message); } catch (e) { error = e.message === 'not a speculum record' ? e.message : `not a speculum record: ${e.message}`; }
      out.push({
        sequenceNumber: m.sequence_number,
        consensusTimestamp: m.consensus_timestamp,
        payer: m.payer_account_id,
        chunks: m.chunk_info?.total ?? 1,
        record,
        error,
      });
    }
    url = j.links?.next ? `${base}${j.links.next}` : null;
  }
  return out;
}

/** The settlement transaction as the mirror node holds it, or null if it has none. */
export async function readSettlement(settlement, { network = 'testnet', fetchImpl = fetch } = {}) {
  const r = await fetchImpl(`${MIRROR[network]}/api/v1/transactions/${mirrorTxPath(settlement)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`mirror node ${r.status} for ${settlement}`);
  const j = await r.json();
  return j.transactions?.[0] ?? null;
}
