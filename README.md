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

There is a fourth ruling, `UNDETERMINED-ON-HISTORY`, for when the bytes were judged but the record of past verdicts could not be read. It carries `level: REFUSE` so nothing downstream can mistake it for a full verdict. See [What the subgraph decides now](#what-the-subgraph-decides-now).

## Design decisions worth stating

**The decoder never sees the intent.** If both sides shared a code path the comparison would be circular. `decode()` takes a transaction and nothing else.

**Refusal does not leak into guessing.** When the deed is undeterminable the comparator returns immediately rather than emitting mismatches derived from fields it never read. There is a test asserting exactly one finding comes back, not a pile of invented ones.

**Unknown selector and unreadable arguments are different failures.** Both refuse, but an operator reading the log needs to know whether the function was unrecognised or merely unparseable. An earlier version conflated them because the check was structurally always true; the test caught it.

**A batch is judged leg by leg and is only as good as its worst leg.** Both Uniswap multicall selectors decode, `multicall(uint256 deadline, bytes[] data)` from SwapRouter02 and `multicall(bytes[] data)` from the V3 SwapRouter, through one path that finds the `bytes[]` input by type and ignores the deadline. Each leg is decoded one at a time with the same decoder, from bytes alone, and the batch takes the worst verdict any leg reached. One unknown or unreadable leg refuses the whole batch, and it is reported as unknown or unreadable rather than collapsed into one class at the batch boundary. Every finding a leg raises names its leg in the detail, so an operator reading the log knows which leg did it. Native value sums across legs; tokens and recipients become sets and each member is compared against the declaration; movements of one asset are summed, because two legs of half the amount still move the whole of it. Nesting and leg count are capped (2 frames, 32 legs) and a batch past either cap refuses with the reason rather than recursing. An earlier version refused every batch outright rather than claim a recursion it did not have.

**An honestly declared unlimited approval is not a lie.** It still blocks, because it is still irreversible, but it is tagged as declared rather than as deception.

**The contract stores nothing.** Every check is an event, because the consumer is an indexer, not another contract. A check that costs 20k gas is a check that gets skipped, and a skipped check protects nobody.

**The contract is not an executor.** speculum holds no funds and routes no calls, so it cannot become a point of failure inside a transaction it is judging.

## State

Verified by running, not asserted:

- 281 tests pass, 0 fail. `npm test`
- Divergence engine and decoder: built and tested offline against calldata encoded with viem, so the bytes under test are real bytes.
- Simulation layer: built, tested against a scripted RPC. It catches what decoding cannot, including fee-on-transfer tokens moving more than the argument states and undeclared assets leaving the sender. **Run against a live node** on Sep 7 2026 with `node bin/probe-sim.js`: `verifyEffect` through the project's own `jsonRpc` transport against `ethereum-rpc.publicnode.com`, mainnet state at block 25,925,120, sender Circle's EOA holding 53.1M USDC, one `USDC.transfer` of 100 USDC to the burn address. Observed, not assumed:
  - declared 100 USDC: `PASS`, delta `-100000000`, no findings.
  - declared 50 USDC: `BLOCK` on `BALANCE_DELTA_MISMATCH`, detail `declared 50000000, 100000000 actually leaves`.
  - response shape `{ jsonrpc, id, result }` with `result` one block carrying full header fields (`number`, `hash`, `timestamp`, `gasUsed`, `baseFeePerGas`, `stateRoot`, ...) plus `calls: [3 × { returnData, logs, gasUsed, status }]`, 2,974 bytes. Exactly the shape the parser expects.
  - `gasUsed` 31,259 for each `balanceOf` probe, 44,932 for the transfer, 107,450 for the block. `baseFeePerGas` comes back `0`, so gas is measured but fees are not.
  - wall clock 58, 59, 69 and 80 ms per `eth_simulateV1` round trip across two runs of both cases, HTTP 200 every time.
  - nothing was signed or broadcast. Validation is off, so the node runs the call from an address it holds no key for; the balance it debits is real and the block is discarded.
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
- Subgraph: **deployed and synced**, v0.0.3 on Subgraph Studio, Base Sepolia, indexing both contracts.
  - query endpoint `https://api.studio.thegraph.com/query/1758736/speculum/v0.0.3`, pinned once in `src/subgraph.js` and imported by everything that reads it
  - build `QmPJf2h1ZQdwmmU1XQe4VTNXK4UDib7uC252PV3J2eK3uc`. Earlier builds still answer: v0.0.2 `QmPi9BvZaN8MtxUJr4rX2Kny21TaRmdPBfAx7VWbDTynqV` predates signed overrides, v0.0.1 `QmcPcbZCirWiJik1zxGbhLCw8RSGwYTRWgH6Lx2X6UhHtZ` predates the `DeedIndex` and `IntentIndex`
  - second contract `0x304200f5efc39c36db78e24c42f91f4be688673d`, deployed in block 46508257, the one that recovers the approver before it will emit an override; the first, `0xb71db47937d8ddbe1fff208cf5da2727c3f90d9b`, stays indexed from block 46426715
  - **18 checks indexed** from three demo runs of the six cases, two back to back on Sep 5 2026 (blocks 46432987–46433058) and one on Sep 6 (blocks 46450964–46450996), read from v0.0.2 at block 46507336 on Sep 7: 3 passed, 12 blocked, 3 refused. Divergence rate recomputed from those parts, (12 + 3) / 18 = 0.8333, which is what the agent entity stores. RECIPIENT_MISMATCH is the most common finding at 6; every other finding recorded is at 3. `irreversible` resolves true only for the checks carrying UNBOUNDED_APPROVAL or APPROVAL_FOR_ALL, and the finding counters carry the irreversible flag on exactly those two classes.
  - that reconciliation is the proof the bitfield survives JavaScript to Solidity to AssemblyScript with no drift across 15 bit positions, which is the one thing here that could have been silently wrong without anything failing.
  - 11 overrides. 3 carry a device signature the contract recovered on chain, approver `0xC34b0cdE9646c420Bf53BabaBdB0fd5986fd3E21`, recorded by contract `0x304200f5efc39c36db78e24c42f91f4be688673d` in a demo run of the 6 cases on Sep 7 2026, 531,072 gas total. Device times observed by the demo: 15,031 ms, 4,406 ms and 4,315 ms for the three approvals, and one rejection at 6,417 ms that recorded no override, because a refusal has nothing to prove. `npm run verify` recovers each of the three signatures again off chain from the indexed deed hash, level and reason, and gets the same approver the contract got. Two of the three taps came in under the 4 to 6 s scripted floor measured earlier, so timing could never have proven them; the block-gap analysis in [What the chain says about the overrides](#what-the-chain-says-about-the-overrides) is dead as a method, and the signature is what proves a human now. The 8 overrides from the first contract stay in the record as unproven, `signed: false`, and are never back-claimed. Hedera is **not** on The Graph's supported network list, checked against the full table of 130+ networks, so the verdict log cannot be both Hedera-hosted and Graph-indexed. It deploys to Base Sepolia for indexing and to Hedera separately for the payment rail.

- History layer: **run against the deployed subgraph over the network** on Sep 7 2026 with `npm run history`. Eight cases, one round trip each. On the pinned v0.0.2: lookup latency 212 ms min, 260 ms median, 281 ms max; the earlier runs against v0.0.1 measured 253/267/288 ms and 205–297 ms. Three verdicts changed because of what the record held, the same three on both versions. Numbers and the cases are in [What the subgraph decides now](#what-the-subgraph-decides-now).

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

## What the chain says about the overrides

An override asserts that a human approved. Until the signed-override path
below exists it commits to nothing, so the only evidence for a human is time:
a device confirmation should leave a larger gap between a check and the
override answering it than a script does. Measured on Sep 7 2026 against
v0.0.2 at block 46,507,833, on all 18 checks and all 8 overrides.

Base Sepolia's block time is 2.000 s: 2000 s over the 1000 blocks before
46,507,837, 2.000 s across both demo windows, and every one of 20 consecutive
deltas exactly 2 s. The analysis rests on that number, so it was measured
rather than assumed.

| override block | run | gap to the check the index links | gap to the preceding Speculum activity |
|---|---|---|---|
| 46433040 | 2 | 11 blocks, 22 s | 22 s |
| 46433048 | 2 | 59 blocks, 118 s | 16 s |
| 46433052 | 2 | 62 blocks, 124 s | 8 s |
| 46433056 | 2 | 65 blocks, 130 s | 6 s |
| 46450980 | 3 | 14 blocks, 28 s | 28 s |
| 46450985 | 3 | 3 blocks, 6 s | 6 s |
| 46450989 | 3 | 3 blocks, 6 s | 6 s |
| 46450995 | 3 | 4 blocks, 8 s | 8 s |

Run 1 recorded six checks and no overrides.

**Three of those gaps are the ordering bug, found in the record.** In blocks
46433040 and 46433048 the `recordOverride` transaction sits at a lower
transaction index and a lower nonce than the `record` transaction for the same
case (index 8 against 15, nonce 17 against 18; index 8 against 20, nonce 20
against 21). Run 2 sent each override before its own verdict, so the index
linked those overrides to the previous run's check on the same deed hash, and
the gaps of 118 to 130 s measure that bug and nothing about a human. This is
the failure mode the project exists to catch, a record that says something
plausible about an event that did not happen that way, reproduced inside its
own record. The section above describes the fix; this is what the fix left
behind on chain.

**The rest does not separate into two groups.** The scripted floor is not one
block. The demo waits for each receipt with viem's default 4 s polling, so a
scripted record-then-override sequence costs roughly 4 to 6 s on its own. Six
overrides landed 6 to 8 s after the preceding activity, leaving 0 to 4 s for
the device, which a human already holding it can do and a script can match.
Two overrides, the first escalation of each run, sit at 22 s and 28 s, and no
scripted path explains those. The 14,435 ms figure recorded above for
`signPersonalMessage` was a single sample, not a floor, and it is not visible
in the six.

So the chain establishes this much and no more: two of eight overrides carry a
human-sized delay, and six cannot be told from a script by timing. That is
why an override now has to prove itself, below, rather than be believed.

## What the subgraph decides now

Until this layer existed the subgraph was write-only. Every verdict was
indexed and nothing read the index to decide anything, which made it a
dashboard. Now the gate reads the record over the network before it rules, and
what it reads can change the ruling.

**What is read.** One GraphQL request to the deployed subgraph
(`api.studio.thegraph.com/query/1758736/speculum/v0.0.3`, Base Sepolia, set
`SUBGRAPH_URL` to read another deployment) answers three questions at once:

- every prior verdict on this exact deed hash, and whether any of them was
  not a PASS, plus any human overrides recorded against those bytes;
- the signing agent's running record: checks, passed, blocked, refused, and
  the divergence rate the mappings maintain;
- whether the recipient or spender in this deed appears in the blocked
  record, in either role the on-chain event carries: as an agent that has been
  blocked, or as the target of a blocked check.

The Studio endpoint answers without a key. That was established by calling it,
three times, HTTP 200 each time, not read off a page. The production gateway
does need one; `SUBGRAPH_API_KEY` is read from the environment, sent as a
bearer header, and never printed. The reader's `describe()` redacts a key
embedded in a gateway URL, and a transport error that echoes the key is
redacted before it becomes a finding. Both are tested.

**Observed latency.** `npm run history` on Sep 7 2026, eight cases, one read
each. Against the pinned v0.0.2, indexed to block 46,507,257: 212 ms min,
260 ms median, 281 ms max per lookup. Two earlier runs of the same eight
against v0.0.1, indexed to block 46,506,850, measured 253/267/288 ms and
205 ms to 297 ms. A wider query with more aliases measured 354 ms to 828 ms. The reader gives up at 8 s and reports that as
unavailable rather than hanging the gate.

**The rules, and why each exists.** History can escalate a verdict and can
never soften one. Every rule either raises a finding or does nothing.

1. *Repeat of a blocked deed* (`HISTORY_REPEAT_OF_BLOCKED_DEED`). If these
   exact bytes were ever blocked or refused, they escalate now, whatever the
   current declaration says. The record holds the case that motivates this:
   byte-identical calldata judged PASS under one declaration and BLOCK under
   another. Once bytes have been presented under a false description, their
   reappearance under a matching one is the "rewrite the intent to fit the
   calldata" move that on-chain declaration ordering exists to catch. A prior
   human override is reported but does not carry forward: it approved one
   moment, not the bytes forever. The escalation reads its own one-row query
   for "any non-PASS on this hash", so the cap on the listed verdicts cannot
   hide a block.
2. *Divergent agent* (`HISTORY_AGENT_DIVERGENT`). An agent whose divergence
   rate is above 0.5, over at least 5 checks, loses the benefit of the doubt on
   borderline passes. A borderline pass is one that rests on the absence of a
   claim: the comparator only checks fields the intent declares, so an intent
   that omits the recipient cannot mismatch on it. The same goes for a pass
   that used tolerance slack, and for a batch. A full-field pass by the same
   agent still passes; the record says the agent lies, not that verified bytes
   are wrong. Why 0.5: an agent wrong more often than right has forfeited the
   doubt. Why 5: one blocked check is a rate of 1.0 and means nothing; five is
   small enough to catch an agent in its first session and large enough that
   one mistake is not a permanent brand. Both are in `DEFAULT_POLICY` and can
   be tightened per gate.
3. *Counterparty in the blocked record* (`HISTORY_COUNTERPARTY_BLOCKED`).
   Value about to go to, or allowance about to be granted to, an address the
   blocked record already knows escalates. One human tap is cheap against an
   irreversible transfer to such an address. A limitation, stated plainly: the
   `Checked` event carries the agent and the call target, not the recipient or
   spender, so "appeared as a recipient before" is not answerable from this
   contract. The address is matched against the two roles that are on chain,
   and the finding names which one matched. Making the counterparty a
   first-class field needs an event change, a redeploy and a reindex.
4. *Unreadable record* (`HISTORY_UNAVAILABLE`). If the subgraph is
   unreachable, answers with errors, times out, or reports indexing errors,
   the ruling is `UNDETERMINED-ON-HISTORY` with `level: REFUSE`, and the
   merits verdict is carried separately so an operator can still see what the
   bytes earned. There is no fallback to a no-history verdict. A partial ruling
   presented as complete is the exact failure this project exists to catch.
   Tested with a scripted transport for each failure, and once with no mock at
   all: a real socket to a port nothing listens on.

**The invariant.** History never softens. It is enforced structurally: the
level table for history findings has no PASS in it, the gate combines levels
with the same `worst()` the rest of the engine uses, and a test asserts the
table stays that way. It is also tested by enumeration: eleven records,
including a spotless agent and a deed with five prior overrides, against five
merits outcomes, sixty combinations, and the ruling is never below the
merits. A clean record does not make bad bytes good.

**What goes on chain is still the merits.** `toRecord()` writes the verdict
the bytes earned, not the ruling after history. The record is the measure of
how often an agent's words and bytes disagree; the history rules are a policy
applied to that measure. Writing escalations back would count "blocked because
it was blocked before" as a fresh divergence, inflate the rate, and trigger
more escalations off the inflated rate. The record would start measuring the
policy instead of the agent. The loop is open by construction.

**A verdict that changed, from the live record.** The demo's first case is an
honest transfer of 100 USDC to `0x…dEaD`, fully declared. On its bytes alone
it is `PASS`, with no findings. Its deed hash is
`0xc9e4f5435cfd5ae7b9f5347525039099a2a50cd200e912bb33f0cba32b86e1ff`, and the
subgraph holds six verdicts on that hash: three `PASS` and three `BLOCK` on
`RECIPIENT_MISMATCH`, because the demo also submits the same bytes under a
declaration that names a different recipient. With history consulted the
ruling is:

```
honest transfer (bytes shared with the case below)
  bytes alone   PASS
  with history  BLOCK   <- changed
  record        6 prior verdict(s) on these bytes: 3 PASS, 3 BLOCK, 0 REFUSE, 2 override(s); indexed to block 46506850; 288ms
  history       HISTORY_REPEAT_OF_BLOCKED_DEED — judged 6 time(s) before: 3 passed, 3 blocked, 0 refused, 2 human override(s), which do not carry forward
```

Two more changed in the same run. A transfer with the recipient left
undeclared, never seen before, passed on its bytes and was escalated because
the agent's indexed record is 15 divergences in 18 checks, rate 0.83, over the
0.5 threshold; the finding says which claim the pass was resting on. And an
exact, fully declared approval to the Uniswap router was escalated because the
router is the target of three blocked checks in the record. The five cases
that did not change were already `BLOCK` or `REFUSE` on their bytes, or were a
fully declared transfer by an agent whose record could not lower a verified
pass. Three of eight changed, none softened. The output quoted above is from
the run against v0.0.1; the run against the pinned v0.0.2 changed the same
three cases, and both versions hold the same six verdicts on that deed hash.

Two endpoint facts worth knowing. Both `v0.0.1` and `v0.0.2` of the subgraph
answer and are synced to within three blocks of the chain head, holding the
same 18 checks, 18 declarations and 8 overrides; only `v0.0.2` carries the
`DeedIndex` and `IntentIndex` described above, so its overrides resolve and
`Agent.overridden` is 8 where `v0.0.1` reports 0. Five references used to
disagree on which version to read, and both answering is why nothing failed.
The version is now written once, in `src/subgraph.js`, and imported by the
history reader, `bin/verify.js` and `bin/demo.js`; `SUBGRAPH_URL` in the
environment still takes precedence. And Bytes filters on graph-node are
case-insensitive, checked by querying the same hash in both cases; the reader
lowercases anyway.

`bin/demo.js` and `hedera/server.js` still construct the gate without a
reader, so they rule on merits alone and their results say
`history.consulted: false`. Wiring the paid service is a pricing decision, not
a code one: a lookup that comes back unreadable makes a paid verdict
undetermined, and whether that call is charged is an open question.

## An override now proves itself

Until this change an override asserted that a human approved and committed
to nothing: the event carried `msg.sender`, which is the relayer. The section
above shows what that left on chain, eight overrides of which six cannot be
told from a script. That is the project's own rule, that a confirmation which
does not commit to specific bytes is worse than none, broken inside the
project.

**What changes.** The device already signed the approval message; the
signature was thrown away after the local approval was stored. Now it is kept
and put on chain. `recordOverride(deedHash, level, reason, signature)` rebuilds
the exact text the device displayed from its parts, hashes it the EIP-191 way
`signPersonalMessage` does, recovers the signer with `ecrecover`, and refuses
to emit anything if nobody recovers. The message is rebuilt on chain rather
than passed in, so a signature can only ever be over a message that names
this deed hash. `Overridden` now carries the recovered `approver`, the
`submitter` that relayed it, the `level` and `reason` the human saw, and the
65-byte `signature`. The subgraph indexes all of it and a new field, `signed`,
says whether an override carries a recoverable device signature.

**Old overrides read as unproven.** The first contract stays a data source in
the subgraph, so its 18 checks and 8 overrides remain in the record
unchanged, and each of those overrides is indexed with `signed: false`, no
signer, no level, no reason. Nothing back-claims them. There is nothing on
chain that could.

**`npm run verify` gains an assertion**: every override carries a recoverable
device signature, and every signed one is complete. The eight legacy overrides
fail it and will keep failing, for the same reason the earlier violation
stays red: a verifier that learns to look past what it cannot prove proves
nothing. Against a subgraph that predates signed overrides the script stops
with "the pinned subgraph predates signed overrides" rather than silently
skipping the assertion; that was the behaviour observed against v0.0.2 before
v0.0.3 was published.

**Verified before deploying, on a real EVM.** `node bin/probe-override.js`
places the compiled runtime code on `sepolia.base.org` through an `eth_call`
state override and calls it there, so nothing is deployed and no key that
matters signs anything. Observed on Sep 7 2026:

- the contract rebuilds the device message byte for byte, 174 characters;
- a real secp256k1 signature from a throwaway account recovers on chain to
  the same address viem recovers;
- the same signature over a different deed, a different reason, or a
  different level recovers a different address, so the binding holds on all
  three;
- a short signature recovers nobody; `v` as 0/1 is accepted alongside 27/28;
- `recordOverride` reverts with no signature and reverts on a PASS;
- gas by `eth_estimateGas` from the deployer's own address: deploy 872,801,
  `record` 26,416, `declareIntent` 46,662, signed `recordOverride` 61,654.

The signed override costs about 18 times a bare `record`. That is the price
of the claim being provable, and it is paid once per human decision, not per
check.

**The deploy is funded.** Deployer `0xC50D…54f6` holds 0.14998 ETH on Base
Sepolia; at the measured gas price of 0.006 gwei the deploy's execution costs
about 0.0000052 ETH, a 28,640× margin before the L1 data fee, which is small at
this size.

**Done, by the owner, with the device.** `bash bin/release.sh` ran on Sep 7
2026. The contract deployed to `0x304200f5efc39c36db78e24c42f91f4be688673d`
in block 46508257, the subgraph published as v0.0.3 and was pinned, and the
demo ran its 6 cases with the Ledger attached for 531,072 gas in total. Four
escalations reached the device: three were approved, at 15,031 ms, 4,406 ms
and 4,315 ms, and one was rejected at 6,417 ms, which recorded nothing. The
three approvals are on chain as signed overrides, approver
`0xC34b0cdE9646c420Bf53BabaBdB0fd5986fd3E21`, recovered by the contract from
the device signature and recovered again by `npm run verify` off chain from
the indexed deed hash, level and reason, to the same address.

Two of those three taps took less than the 4 to 6 s scripted floor measured
in [What the chain says about the overrides](#what-the-chain-says-about-the-overrides).
Timing could never have proven them. That retires the block-gap analysis as a
method, and it was worth doing once to learn exactly why: a fast human and a
script leave the same gap, and only a signature over the deed hash tells them
apart. The 8 overrides from the first contract remain `signed: false`, and
`npm run verify` keeps failing on them, alongside the historical PASS-linked
override, because both are true and neither can be changed.

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
