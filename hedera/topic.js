#!/usr/bin/env node
// speculum — create the audit topic, once
//
//   HEDERA_OPERATOR_ID=0.0.x HEDERA_OPERATOR_KEY=0x... node hedera/topic.js
//
// Prints the topic id. Put it in HEDERA_TOPIC_ID for the service. A topic is
// created once and kept; creating one per boot would scatter the record.
// The key is read from the environment and never printed.

import { createTopic, MIRROR } from './audit.js';

const operatorId = process.env.HEDERA_OPERATOR_ID;
const operatorKey = process.env.HEDERA_OPERATOR_KEY;
const network = process.env.HEDERA_NETWORK ?? 'testnet';

if (!operatorId || !operatorKey) {
  console.error('set HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY (an ECDSA key for a funded account)');
  process.exit(1);
}

console.log(`creating the audit topic on hedera ${network} as ${operatorId}`);
const t = await createTopic({ operatorId, operatorKey, network });
console.log(`status        ${t.status}`);
console.log(`topic         ${t.topicId}`);
console.log(`transaction   ${t.transactionId}`);
console.log(`mirror        ${MIRROR[network]}/api/v1/topics/${t.topicId}`);
console.log(`\nexport HEDERA_TOPIC_ID=${t.topicId}`);
