#!/usr/bin/env node
// speculum — check the audit trail without having been there
//
//   node hedera/audit-verify.js 0.0.<topic> [sequenceNumber]
//
// Reads the topic from the public mirror node, decodes every record, and for
// each one fetches the settlement it claims to have been paid by and checks
// that the mirror node agrees: the transaction exists, succeeded, and moved
// the recorded amount from the recorded payer to the recorded payee. No key,
// no account, no trust in this repository. Exit code is non-zero if any record
// does not hold up.

import { readTopic, readSettlement, MIRROR } from './audit.js';

const topicId = process.argv[2];
const only = process.argv[3] ? Number(process.argv[3]) : null;
const network = process.env.HEDERA_NETWORK ?? 'testnet';

if (!topicId) {
  console.error('usage: node hedera/audit-verify.js 0.0.<topic> [sequenceNumber]');
  process.exit(1);
}

console.log(`audit trail ${topicId} on hedera ${network}`);
console.log(`mirror      ${MIRROR[network]}/api/v1/topics/${topicId}/messages\n`);

const messages = await readTopic(topicId, { network });
const picked = only == null ? messages : messages.filter((m) => m.sequenceNumber === only);
if (!picked.length) {
  console.log(only == null ? 'the topic has no messages yet' : `no message with sequence number ${only}`);
  process.exit(1);
}

let bad = 0;
for (const m of picked) {
  console.log(`#${m.sequenceNumber}  consensus ${m.consensusTimestamp}  submitted by ${m.payer}`);
  if (!m.record) { console.log(`   ${m.error}`); bad++; continue; }
  const r = m.record;
  console.log(`   verdict      ${r.verdict} (${r.outcome})${r.findings.length ? `  ${r.findings.join(', ')}` : ''}`);
  console.log(`   intent       ${r.intentHash}`);
  console.log(`   deed         ${r.deedHash}`);
  console.log(`   settlement   ${r.paid.settlement}`);

  let tx;
  try { tx = await readSettlement(r.paid.settlement, { network }); }
  catch (e) { console.log(`   mirror node  ${e.message}`); bad++; continue; }
  if (!tx) { console.log('   mirror node  NO SUCH TRANSACTION, the record claims a payment the ledger does not hold'); bad++; continue; }

  const paid = (tx.transfers ?? []).find((t) => t.account === r.paid.payTo && String(t.amount) === r.paid.amount);
  const debited = (tx.transfers ?? []).find((t) => t.account === r.paid.payer && String(t.amount) === `-${r.paid.amount}`);
  const ok = tx.result === 'SUCCESS' && tx.name === 'CRYPTOTRANSFER' && paid && (r.paid.payer ? debited : true);
  console.log(`   ledger says  ${tx.name} ${tx.result} at ${tx.consensus_timestamp}, ${paid ? `${r.paid.amount} tinybar to ${r.paid.payTo}` : 'no transfer of the recorded amount to the recorded payee'}${r.paid.payer ? (debited ? ` from ${r.paid.payer}` : ', payer not debited') : ''}`);
  console.log(`   ${ok ? 'holds' : 'DOES NOT HOLD'}\n`);
  if (!ok) bad++;
}

console.log(`${picked.length} record(s), ${picked.length - bad} hold, ${bad} do not`);
process.exit(bad ? 1 : 0);
