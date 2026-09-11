# Brief: a page for the Live Demo button

The brief this round of work was built against, kept verbatim because ETHGlobal
asks that spec files and prompts be in the repository when AI tooling is used.
Received Sep 9, 2026.

Every brief in this repository, in the order the rounds ran: [multicall legs and
the live simulation](docs/BRIEF-multicall-simulation.md), [the Graph history
layer](docs/BRIEF-graph-history.md) and [signed device
overrides](docs/BRIEF-signed-overrides.md), all three Sep 7; [the Hedera x402
gate](hedera/BRIEF.md), Sep 8; this one, Sep 9; and [the attribution and reuse
sections](docs/BRIEF-attribution.md), Sep 11.

---

In the speculum repo, /Volumes/D/speculum.

The ETHGlobal Live Demo button now points at https://speculum.ochinimus.app,
which currently returns the JSON service descriptor. A judge clicking Live Demo
lands on raw JSON. Make the root serve a real page for browsers while keeping
the JSON contract intact for machines.

1. Content negotiation on GET /. If the Accept header prefers text/html, serve
   a single self-contained HTML page. Otherwise serve exactly the JSON that is
   served today, byte for byte unchanged. Any client already parsing that JSON
   must not break. Add a test that asserts the JSON path is unchanged.

2. The page renders, from the live descriptor rather than hardcoded copy:
   what the service does, the POST /check endpoint, that payment is x402 v2 on
   hedera:testnet through the Blocky402 facilitator, both pricing tiers with
   their tinybar amounts and what each covers, the three verdicts, and the HCS
   topic 0.0.10422195 with its mirror link as a clickable anchor.

3. One copyable curl showing an unpaid request returning 402 with the challenge,
   so a reader can see the paywall without a wallet. Use the real endpoint. Do
   not fabricate a response body: run the curl, paste what actually came back.

4. No framework, no build step, no external fonts or CDN. Inline CSS. It must
   render with JavaScript disabled.

5. Do not touch the gate, the Ledger signing path, the subgraph, history.js or
   the Hedera audit module. This is the root route only.

RULES
- Commit incrementally, several small commits, not one squashed push.
- No Co-Authored-By trailers, no AI attribution in git metadata, no changes to
  git authorship, and never pass --no-verify.
- Save this brief into the repo as a BRIEF.md alongside the existing
  hedera/BRIEF.md. ETHGlobal requires spec files and prompts in the repo when
  AI tooling is used, and right now only one round has one.
- Report git log -1 --oneline origin/main when done. Do not deploy.
