# Brief: the attribution and reuse sections

The brief this round of work was built against, kept verbatim because ETHGlobal
asks that spec files and prompts be in the repository when AI tooling is used.
Received Sep 11, 2026.

---

In the speculum repo, /Volumes/D/speculum.

Two sections owed in README.md, both to satisfy ETHGlobal rules read live on Sep 11 2026. Touch nothing else.

1. The AI attribution rule asks which parts of the code, which specific files, or which assets were generated or assisted by AI. The current "## AI attribution" section states the division of labour well and names no files. Keep every word of it and append this subsection at its end, before "## Licence":

### Which files, and by which route

Two routes were used and they split by date.

Sep 5 and 6, drafted from chat transcripts rather than an agent working inside the repository, so no brief file exists for those rounds: `src/types.js`, `src/decode.js`, `src/compare.js`, `src/gate.js`, `src/onchain.js`, `src/simulate.js`, `contracts/Speculum.sol`, the first subgraph in `subgraph/schema.graphql`, `subgraph/src/mapping.ts` and `subgraph/subgraph.yaml`, the tests written beside them in `test/compare.test.js`, `test/gate.test.js`, `test/onchain.test.js` and `test/simulate.test.js`, the tooling in `bin/compile.js`, `bin/deploy.js`, `bin/demo.js`, `bin/verify.js`, `bin/probe-ledger.js` and `bin/probe-rpc.js`, and the first versions of `hedera/server.js`, `hedera/agent.js`, `hedera/probe-key.js` and `hedera/run.sh`.

Sep 7 to 9, Claude Code working from a written brief, each brief committed verbatim:

- [docs/BRIEF-graph-history.md](docs/BRIEF-graph-history.md) and [docs/BRIEF-signed-overrides.md](docs/BRIEF-signed-overrides.md), both Sep 7: `src/history.js`, `src/subgraph.js`, `src/policy.js`, `src/deployment.js`, `bin/probe-history.js`, `bin/probe-override.js`, `bin/probe-sim.js`, `test/history.test.js`, and the override path in `contracts/Speculum.sol`.
- [hedera/BRIEF.md](hedera/BRIEF.md), Sep 8: `hedera/verdict.js`, `hedera/audit.js`, `hedera/audit-verify.js`, `hedera/topic.js`, `test/audit.test.js`, and the paid path in `hedera/server.js`.
- [BRIEF.md](BRIEF.md), Sep 9: `hedera/landing.js`, `test/landing.test.js`, and the content negotiation in `hedera/server.js`.

This file was drafted by the model throughout and rewritten by hand whenever a claim in it failed verification.

What no route produced: the probe results, the device presses, the deployments, the funded accounts and every number recorded above. Each came from running the thing.

2. Two further rules ask the same thing in different words, be transparent about open source libraries and boilerplates, and clearly distinguish what is new from what is reused. Add this as a new section immediately before "## AI attribution":

## What is new and what is reused

Everything in `src/`, `contracts/`, `hedera/`, `bin/`, `subgraph/src/` and `test/` was written during ETHOnline, first commit Sep 5 2026. Nothing here predates the event and nothing extends an earlier project. No starter kit or boilerplate was used.

What is reused is third party and public, all of it installed from npm rather than copied into the tree:

- `viem` 2.56 for ABI encoding and decoding and for the RPC calls
- `express` 5.2 for the HTTP surface of the paid service
- `@x402/hedera` 2.25 for the payment challenge and the client signer
- `@hiero-ledger/sdk` 2.85 for the consensus topic and the ledger queries
- `@ledgerhq/hw-app-eth` 7.8 and `@ledgerhq/hw-transport-node-hid` 6.33 for the hardware signing path
- `solc` 0.8.36 for compiling the contract
- `@graphprotocol/graph-cli` 0.97 and `@graphprotocol/graph-ts` 0.38 for the subgraph

`package.json` and `subgraph/package.json` are the complete list.

3. Save this brief into the repo as docs/BRIEF-attribution.md, verbatim, as the other rounds do, and add it to the index paragraph at the top of BRIEF.md alongside the existing three.

RULES
- Commit incrementally, several small commits, not one squashed push.
- No Co-Authored-By trailers, no AI attribution in git metadata, no changes to git authorship, never pass --no-verify.
- Do not touch src, contracts, hedera, bin, subgraph or test. README.md, BRIEF.md and the new docs file only.
- Run npm test before the final commit and report the result.
- Report git log --oneline -5 and git status when done. Do not deploy.
