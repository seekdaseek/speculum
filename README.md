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

- 46 tests pass, 0 fail. `npm test`
- Divergence engine and decoder: built and tested offline against calldata encoded with viem, so the bytes under test are real bytes.
- Contract compiles as written here but has **not** been deployed. No address exists yet.
- Simulation against live chain state: **not built**. The current engine compares declaration against decoded calldata only. Balance-delta checks need an RPC and are the next piece.
- Ledger confirmation path: **not built**.
- Subgraph: **not built**.

## Run it

```
npm install
npm test
```

## Licence

MIT
