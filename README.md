# speculum

An approval gate that checks whether an AI agent's declared intent matches the transaction it is about to sign.

The agent states what it is doing before it signs. speculum decodes the calldata independently, derives what the transaction actually does, and compares the two. Match passes. Divergence blocks and escalates to a hardware confirmation. Undeterminable refuses, and says why.

Built at ETHOnline 2026.

## The problem

Agent stacks trust the model's sentence. An agent says it is swapping 100 USDC for ETH, emits calldata, and the signer signs bytes nobody compared against the sentence.

The failure mode is not an agent going rogue. It is an agent being confidently wrong: an approval that comes out unbounded when an exact amount was intended, a router address that is not the router, a recipient that is not you, a token address recalled from training data rather than resolved.

Cobo documented a case where an agent wrongly concluded it could not produce an EIP-712 signature, generated a temporary keypair, moved the user's funds to that address, and completed the trade there. The transaction succeeded. The assets ended up somewhere the user did not control. Nothing in that flow was malicious and nothing reverted.

Transaction simulation exists, and it answers a different question. Simulators tell a human what state will change. They do not know what the agent claimed, so they cannot tell you the two disagree.

## What speculum checks

Fifteen named divergence classes, each with a stable code.

Decoded and disagreeing: `ACTION_MISMATCH`, `TOKEN_MISMATCH`, `RECIPIENT_MISMATCH`, `SPENDER_MISMATCH`, `AMOUNT_EXCEEDS_INTENT`, `CHAIN_MISMATCH`, `NATIVE_VALUE_UNDECLARED`.

Decoded and irreversible: `UNBOUNDED_APPROVAL`, `APPROVAL_FOR_ALL`, `OWNERSHIP_TRANSFER`, `PROXY_UPGRADE`, `SELF_DESTRUCT`.

Undeterminable: `UNKNOWN_SELECTOR`, `MALFORMED_CALLDATA`, `ARGUMENTS_UNDECODABLE`.

## Three verdicts

`PASS` — the deed matches the declaration and nothing irreversible was undeclared.

`BLOCK` — they disagree, or the action cannot be undone. Requires a human.

`REFUSE` — the deed could not be determined. speculum does not guess.

REFUSE outranks BLOCK deliberately. A call that cannot be decoded is worse than a mismatch that can, because a mismatch is at least understood.

## Design decisions worth stating

**The decoder never sees the intent.** If both sides shared a code path the comparison would be circular. `decode()` takes a transaction and nothing else.

**Refusal does not leak into guessing.** When the deed is undeterminable the comparator returns immediately rather than emitting mismatches derived from fields it never read. There is a test asserting exactly one finding comes back, not a pile of invented ones.

**Unknown selector and unreadable arguments are different failures.** Both refuse, but an operator reading the log needs to know whether the function was unrecognised or merely unparseable. An earlier version conflated them because the check was structurally always true; the test caught it.

**A batch refuses rather than pretending.** A multicall is only as knowable as its least knowable leg. Recursing into each leg is the right answer and is not implemented yet. Claiming otherwise would be the exact failure this project exists to catch.

**An honestly declared unlimited approval is not a lie.** It still blocks, because it is still irreversible, but it is tagged as declared rather than as deception.

**The contract stores nothing.** Every check is an event, because the consumer is an indexer, not another contract. A check that costs 20k gas is a check that gets skipped, and a skipped check protects nobody.

**The contract is not an executor.** speculum holds no funds and routes no calls, so it cannot become a point of failure inside a transaction it is judging.

## State

Verified by running, not asserted:

- 97 tests pass, 0 fail. `npm test`
- Divergence engine and decoder: built and tested offline against calldata encoded with viem, so the bytes under test are real bytes.
- Simulation layer: built, tested against a scripted RPC. It catches what decoding cannot, including fee-on-transfer tokens moving more than the argument states and undeclared assets leaving the sender. **Never run against a live node.**
- Gate and approval binding: built and tested. An approval commits to chainId, target, value and calldata; changing one argument, adding value, or switching chain voids it. Single use, with expiry.
- Ledger confirmation port: **run against real hardware.** `@ledgerhq/hw-app-eth` 7.8.16, `@ledgerhq/hw-transport-node-hid` 6.33.5, Ethereum app on device. Measured, not assumed:
  - `getAddress` returns in ~470ms with no prompt on the device.
  - `signPersonalMessage` took 14,435ms and required a physical confirmation. The human-in-the-loop property is real, not asserted.
  - Rejecting on the device returns `0x6985`, "Condition of use not satisfied". The classifier reports it as *declined on device*. Confirmed by pressing reject on real hardware, not read off a table.
  - Status code `0x6d00` is returned by the dashboard when the Ethereum app is not open. It is not a refusal, and classifying it as one would record a human decision that never happened.
  - `signPersonalMessage` is deterministic: the same message and key produce a byte-identical signature every run. An approval signature is therefore replayable as a string, which is why the gate stores approvals with single use and expiry rather than treating a signature as authority.
- Simulation transport: `eth_simulateV1` confirmed working on `ethereum-rpc.publicnode.com` and `eth.drpc.org`, returning the shape the parser expects with `gasUsed` present. `cloudflare-eth.com` answers method not found. Support is not universal, so the endpoint matters.
- Contract **compiled**, solc 0.8.36, optimizer on at 200 runs. Measured, not estimated: 961 bytes of bytecode, 186,830 gas to deploy, and `record()` at **3,337 gas**. That last number is the design argument: storing a verdict rather than emitting it would cost roughly six times more for data no contract reads.
- Contract **deployed to Base Sepolia**, verified by reading the code back on chain:
  - address `0xb71db47937d8ddbe1fff208cf5da2727c3f90d9b`
  - deployment block `46426715`, chain `84532`
  - 254,932 gas used, 933 bytes of runtime code
  - the subgraph indexes from that block; starting from zero would crawl the whole chain
  - an earlier deployment at `0x00d6ceec3a85b0f6288df0005e6649f923e472c4` (block 46426233) is superseded and left on chain. Its ABI contains a function named `declare`, which no subgraph can compile against, which is why it was replaced.
- Ledger's own ESM build does not resolve under Node: `lib-es` contains extensionless relative imports and `import` throws `ERR_MODULE_NOT_FOUND`. Their packages must be loaded through `createRequire`. Reproduced both ways before working around it.
- Subgraph: **deployed and synced**, v0.0.1 on Subgraph Studio, Base Sepolia.
  - query endpoint `https://api.studio.thegraph.com/query/1758736/speculum/v0.0.1`
  - build `QmcPcbZCirWiJik1zxGbhLCw8RSGwYTRWgH6Lx2X6UhHtZ`
  - **12 checks indexed** from two demo runs: 2 passed, 8 blocked, 2 refused, divergence rate 0.8333. RECIPIENT_MISMATCH is the most common finding at 4, and `irreversible` resolves true only for UNBOUNDED_APPROVAL and APPROVAL_FOR_ALL.
  - that reconciliation is the proof the bitfield survives JavaScript to Solidity to AssemblyScript with no drift across 15 bit positions, which is the one thing here that could have been silently wrong without anything failing.
  - 4 overrides, each one a physical confirmation on a Ledger that halted execution until it was tapped. Hedera is **not** on The Graph's supported network list, checked against the full table of 130+ networks, so the verdict log cannot be both Hedera-hosted and Graph-indexed. It deploys to Base Sepolia for indexing and to Hedera separately for the payment rail.

## Two defects the subgraph build found

Neither was visible by reading code. Both came out of running the compiler.

**`declare` is a reserved word in AssemblyScript.** The Graph's codegen emits a
binding method per external contract function, so a contract with a function
named `declare` cannot have a subgraph generated against it at all — the
compiler fails on its own generated file. The function is now `declareIntent`,
and `override_` is now `recordOverride` for the same reason. This is a contract
defect, not a tooling quirk: an ABI that cannot be indexed by the ecosystem's
main indexer is broken.

**`uint32` crosses graph-ts's BigInt threshold and `uint8` does not.** The
findings bitfield arrives as `BigInt` while the level arrives as `i32`, so the
bitfield is narrowed once at the handler boundary. Only 15 bits are ever used,
so the narrowing is safe.

## A field that was always true

The first version of the mappings hardcoded every override as `unchecked`,
meaning "a human approved a deed the gate never saw". Overrides arrive keyed by
deed hash while checks are keyed by log position, so connecting them needed an
index that did not exist, and the code shipped with a comment explaining why it
was not built rather than building it.

While the contract had never been called this was invisible. The moment real
data existed, every legitimate approval was reported as a gate bypass. A field
that is always true carries no information and actively misleads, which is the
exact failure this project exists to catch, reproduced inside it.

Fixed with a `DeedIndex` from deed hash to check. The same absence had made
`Agent.overridden` permanently zero, since nothing could increment it.

The same round strengthened `declaredFirst`. It used to ask whether the agent
had ever declared anything at all, which any agent passes after its first
declaration. An `IntentIndex` now lets it ask whether *this* intent hash was
declared, and declared before the check was recorded. The index keeps the
earliest declaration, so re-declaring an intent later cannot make an
already-judged check look as though it had been declared up front.

## Paid for by an agent, on Hedera

The gate is also sold by the call. An agent posts what it says it is about to
do and the calldata it is about to sign, pays in HBAR over x402, and gets the
verdict back. No account, no API key, no subscription.

A real payment has settled on Hedera testnet through the Blocky402 facilitator:
100,000 tinybar for a `decode` tier check, settlement
`0.0.7162784@1788674101.284043818`, verdict `BLOCK` on `RECIPIENT_MISMATCH`.
The agent paid to be told no about its own transaction.

Pricing is metered rather than flat, because a decode-only check is pure
computation while a simulated one costs an RPC round trip. Full detail in
[hedera/README.md](hedera/README.md).

## `npm run verify` fails, on purpose

It reports one violation:

```
FAIL  every resolved override answers a verdict that needed a human
        override at block 46433040 -> PASS []
```

That is real and it stays. Early on, the demo recorded a human approval before
the verdict it answered, so the override resolved against a stale check and
linked to a `PASS`. Nothing escalates on a pass. The ordering was fixed and
every override after that block resolves correctly, but the wrong one is on
chain and cannot be edited.

The assertion could be scoped to blocks after the fix. It is not, because a
verifier that goes green after being taught to ignore the one thing it found is
worth less than one that stays red and says why. That is also the project's own
argument applied to itself: do not report a success you cannot support.

Everything else holds — the contract's clean-verdict invariant seen from the
indexed side, irreversibility derived rather than trusted, gate-bypass
detection, per-agent arithmetic, the divergence rate recomputed from its parts,
and every finding counter recounted from the checks that produced it.

## Ordering is load bearing, and the fix proved it

The first fix resolved every override to a verdict, which looked correct until
one of them pointed at a `PASS`. Nothing escalates on a pass, so the link was
wrong.

Two causes. The demo recorded the human override *before* the verdict it
answered, so the index still held whatever check had last touched that deed
hash. And two demo cases have byte-identical calldata: sending 100 USDC to the
same address, declared once honestly and once as going somewhere else. Same
deed hash, opposite verdicts.

That collision is the thesis stated in two lines. The bytes are not honest or
dishonest by themselves, only against what was claimed about them. It also
means a deed hash is not a unique key for a check, which the index had assumed.
The verdict is now recorded before the human is asked, which is both correct
and the order the real flow has anyway.

## Why the approval binds to bytes

A human confirmation that does not commit to specific bytes is worse than no
confirmation, because it manufactures a record of consent for something nobody
saw. Approvals are keyed by a hash over chainId, target, value and the full
calldata, and `authorise()` re-derives that hash from the transaction being sent
rather than trusting one handed to it. A caller who supplies both a transaction
and a hash is a caller who can supply a matching pair describing different
bytes.

## Run it

```
npm install
npm test
```

## AI attribution

Claude Code wrote most of the code in this repository: the decoder, the
comparison engine, the simulation layer, the gate, the Solidity contract, the
subgraph schema and mappings, the probes, and the tests. That includes this
file.

What that did not cover is everything that made the claims in it true.

Every fact recorded above came from running something on real hardware or a
real network, and that was done by the repository owner, not by the model. The
Ledger requires a physical confirmation and returns `0x6985` when refused:
established by plugging in a device and pressing both buttons, then pressing
reject. `eth_simulateV1` works on two endpoints and is missing on a third:
established by probing five. The contract is live on Base Sepolia: funded and
deployed by hand. None of that is knowable from writing code, and the model had
asserted several of those things confidently before they were checked.

Three errors were caught by the owner rather than by the tests. The contributor
list still showed a co-author after the model had declared the history clean,
because the model had verified commit messages instead of the surface a person
actually looks at. An email address in the imported history was spotted as
wrong. And the model claimed a dashboard setting had been switched when it had
only observed its own client-side state, which the owner contradicted from what
he could see on screen.

The direction is also not the model's. The problem, the decision to build from
scratch rather than extend an existing project, the choice of partner
integrations, and the name are the owner's.

The division worth stating plainly: the model drafted, the owner directed,
executed and verified. Where those two disagreed, verification won, and this
file was rewritten several times because of it.

## Licence

MIT
