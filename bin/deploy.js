#!/usr/bin/env node
// speculum — deploy
//
// Reads the deploying key from DEPLOY_KEY and the endpoint from RPC_URL. The
// key is never printed, never written to a file, and never passed as an
// argument, because arguments end up in shell history.
//
//   node bin/deploy.js
//
// Deliberately does nothing clever. It deploys, waits for a receipt, verifies
// there is actually code at the address, and prints what a later step needs:
// the address and the deployment block, which is where a subgraph must start
// indexing from. Guessing that block, or using zero, makes the first sync
// crawl the whole chain.

import { readFileSync } from 'fs';
import { createWalletClient, createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = process.env.RPC_URL;
const KEY = process.env.DEPLOY_KEY;

if (!RPC) { console.error('set RPC_URL'); process.exit(1); }
if (!KEY) { console.error('set DEPLOY_KEY (never as a command argument)'); process.exit(1); }
if (!/^0x[0-9a-fA-F]{64}$/.test(KEY)) {
  console.error(`DEPLOY_KEY is not a 32-byte hex key (length ${KEY.length}, expected 66 with 0x)`);
  process.exit(1);
}

const artifact = JSON.parse(readFileSync('artifacts/Speculum.json', 'utf8'));
const account = privateKeyToAccount(KEY);

const pub = createPublicClient({ transport: http(RPC) });
const wallet = createWalletClient({ account, transport: http(RPC) });

const chainId = await pub.getChainId();
const balance = await pub.getBalance({ address: account.address });

console.log(`chain      ${chainId}`);
console.log(`deployer   ${account.address}`);
console.log(`balance    ${balance} wei`);

if (balance === 0n) {
  console.error('\nthe deployer has no balance on this chain. fund it first.');
  process.exit(1);
}

console.log('\ndeploying...');
const hash = await wallet.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode,
  chain: null,
});
console.log(`tx         ${hash}`);

const receipt = await pub.waitForTransactionReceipt({ hash });
if (receipt.status !== 'success') {
  console.error(`deployment reverted, status ${receipt.status}`);
  process.exit(1);
}

// A receipt with an address is not proof there is code there. Check.
const code = await pub.getBytecode({ address: receipt.contractAddress });
if (!code || code === '0x') {
  console.error(`no code at ${receipt.contractAddress} despite a successful receipt`);
  process.exit(1);
}

console.log(`\naddress    ${receipt.contractAddress}`);
console.log(`block      ${receipt.blockNumber}`);
console.log(`gas used   ${receipt.gasUsed}`);
console.log(`code size  ${(code.length - 2) / 2} bytes on chain`);
console.log(`\nthe subgraph needs both the address and startBlock ${receipt.blockNumber}`);
