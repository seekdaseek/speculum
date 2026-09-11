# Brief: recurse into multicall legs, and run the simulation against a live node

The brief this round of work was built against, kept verbatim because ETHGlobal
asks that spec files and prompts be in the repository when AI tooling is used.
Received Sep 7, 2026.

---

Work in this repo. Two units. Commit after each logical piece, not one dump at the end — match the existing commit-message register in `git log` (lowercase, "area: what changed and why", no ceremony). Never claim something works that you have not run.

UNIT 1 — recurse into multicall legs.

Today `src/decode.js` case 'multicall' pushes Finding.ARGUMENTS_UNDECODABLE and the whole batch refuses. Replace that with real leg decoding.

- Decode every element of the bytes[] data argument with the same decoder. Attach them as deed.legs, each carrying its own selector, flags, token, recipient, amount and value.
- The batch verdict is the WORST leg. Keep the existing precedence: REFUSE outranks BLOCK outranks PASS. One undecodable leg refuses the whole batch.
- Every finding raised by a leg must carry the leg index in its detail. An operator reading the log needs to know which leg did it.
- Keep UNKNOWN_SELECTOR and ARGUMENTS_UNDECODABLE distinct per leg. The README already argues that distinction matters; do not collapse it at the batch boundary.
- Native value across legs sums. Token and recipient become sets, compared against what the intent declared.
- Depth cap and leg-count cap. A multicall inside a multicall past the cap REFUSES rather than recursing. Do not loop.
- The decoder still never sees the intent. Legs are decoded from bytes alone.

Tests in test/compare.test.js, using real calldata encoded with viem, not fixtures typed by hand:
- clean two-leg batch, exact approve plus swap, matching intent, expect PASS
- batch where one leg is an unbounded approval, expect BLOCK, and assert the finding names that leg index
- batch with one unknown-selector leg, expect REFUSE, and assert exactly one finding comes back rather than a pile
- nested multicall past the depth cap, expect REFUSE

UNIT 2 — run the simulation layer against a live node.

Add bin/probe-sim.js. Use the existing jsonRpc transport and verifyEffect against https://ethereum-rpc.publicnode.com on mainnet state. Run two cases: one where declared amount matches the real balance delta, one where it does not. Print the raw response shape, gasUsed, and wall-clock latency.

Then update the README line that reads "Never run against a live node" with what was actually observed, including the numbers. If it fails against the live node, record the failure verbatim and leave the claim red. Do not delete a claim to make the file look clean.

Do not touch the subgraph, the Hedera service, the deployed contract, or bin/verify.js. The verify failure on the historical override stays failing on purpose.
