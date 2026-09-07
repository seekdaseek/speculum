// speculum — the deployed contracts, pinned once
//
// Two contracts on Base Sepolia. The first emitted overrides that committed to
// nothing; the second refuses to emit one it cannot recover a signer from.
// Both are indexed by the subgraph, so the record is continuous and the old
// overrides read as what they are: unproven.
//
// CONTRACT is written by bin/release.sh from the deploy receipt. Until then
// it is the zero address, and bin/demo.js refuses to run against it.

export const LEGACY_CONTRACT = '0xb71db47937d8ddbe1fff208cf5da2727c3f90d9b';
export const LEGACY_DEPLOY_BLOCK = 46426715;

export const CONTRACT = '0x304200f5efc39c36db78e24c42f91f4be688673d';
export const DEPLOY_BLOCK = 46508257;

export const contractAddress = () => process.env.SPECULUM_CONTRACT ?? CONTRACT;
