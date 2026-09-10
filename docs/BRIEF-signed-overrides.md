# Brief: establish which overrides were device taps, then make them self-proving

The brief this round of work was built against, kept verbatim because ETHGlobal
asks that spec files and prompts be in the repository when AI tooling is used.
Received Sep 7, 2026.

---

Two jobs. Do 1 first and report before starting 2.

1. ESTABLISH WHICH OVERRIDES WERE PHYSICAL DEVICE TAPS, FROM THE CHAIN.

A Ledger signPersonalMessage was measured at 14,435 ms on this hardware and is recorded in the README. Base Sepolia block time is roughly 2 seconds. So a human confirmation should leave a materially larger block and timestamp gap between a check and the override answering it than a scripted call does.

- Query v0.0.2 for all 18 checks and all 8 overrides with block numbers and block timestamps.
- For each override, compute the gap to the check it resolves, in blocks and in seconds.
- Report the distribution. Do NOT decide in advance that a cluster exists. If the gaps do not separate into two groups, say so plainly and stop.
- Confirm Base Sepolia's actual average block time by measuring recent blocks, do not assume 2s.

Report the table before writing anything to the README.

2. MAKE OVERRIDES SELF-PROVING, so no future override needs anyone's memory.

An override currently asserts a human approved. It commits to nothing. The README already argues a confirmation that does not commit to specific bytes is worse than none, so this is the project's own rule broken inside the project.

- Extend the override path so the approver signs the deed hash on the Ledger and that signature is recorded with the override.
- The contract verifies or stores it such that an indexer can recover the signer.
- Subgraph indexes it; a new field states whether an override carries a recoverable device signature.
- bin/verify.js gains an assertion: every override claiming a human confirmation must carry one.
- Old overrides have no signature and must read as unproven rather than being back-claimed. Never invent history.

Deploy the new contract and subgraph version, run the demo with the device attached so real signed overrides exist, and pin the new version in src/subgraph.js.

Commit per piece, no Co-Authored-By, push, print git log -1 --oneline origin/main.
