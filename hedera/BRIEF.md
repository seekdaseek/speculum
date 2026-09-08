# Brief: Hedera x402 gate

The brief this round of work was built against, kept verbatim because ETHGlobal
asks that spec files and prompts be in the repository when AI tooling is used.
Received Sep 8, 2026.

---

SPECULUM — HEDERA x402 GATE. ETHOnline, deadline Sep 13 19:00 Chisinau.

CONTEXT
speculum is an approval gate: an agent declares intent (action, token, amount,
recipient, chain) before signing; the gate independently decodes the calldata,
simulates it, derives what it will really do, and compares. Three outcomes:
match, divergence, undeterminable. Ledger device confirmation and The Graph
history layer are already built and must not be touched.

GOAL TODAY
Make the verdict a paid service on Hedera, so an agent pays per check.

TASK 0 — VERIFY BEFORE BUILDING
Read the Blocky402 facilitator docs. The prize requires settlement through it
specifically. Establish: which network (Hedera testnet vs mainnet), what a
facilitator settlement call actually looks like, whether HBAR or HTS, and what
the 402 challenge/response shape is. If Blocky402 cannot do what this brief
assumes, STOP and report what it actually does. Do not substitute another
facilitator and do not simulate a payment.

TASK 1 — THE GATED SERVICE
Expose the existing verdict engine behind one HTTP endpoint, POST /check.
Request: the declared intent plus the raw transaction (chain id, to, data,
value). Response: verdict (match | divergence | undeterminable), the divergence
class where applicable, and the derived effects the gate computed.
Unpaid requests return 402 with the payment challenge. Paid requests return the
verdict. Price per call, not flat per session.
Reuse the existing engine. Do not rewrite the comparison logic.

TASK 2 — THE CONSUMER
A small agent that: builds a transaction, declares its intent, hits /check,
receives 402, pays, retries, and acts on the verdict. It must complete at least
one REAL paid request end to end against the live endpoint. Record the
settlement reference.
Include one run where the declared intent and the calldata deliberately diverge
(unbounded approval declared as an exact amount), so the paid response is a
block, not a pass. That divergence run is the demo.

TASK 3 — AUDIT TRAIL
Write each verdict to Hedera Consensus Service: a hash of the declared intent,
a hash of the transaction, the verdict, and the settlement reference. The prize
lists verifiable payment audit trails on HCS under extra points, and it is the
same claim speculum already makes on-chain elsewhere: the record must be
checkable by someone who was not there.

TASK 4 — DOCS
README section covering setup, architecture and the payment flow, with the real
endpoint, the real settlement reference from Task 2, and the price per call.
State plainly which network it runs on.

RULES
- Commit incrementally as you go, several small commits, not one squashed push.
  ETHGlobal treats a single large commit as unqualified.
- No Co-Authored-By trailers, no AI attribution in git metadata, no changes to
  git authorship.
- Save this brief into the repo. ETHGlobal requires spec files and prompts to be
  in the repo when AI tooling is used.
- Never report a payment as settled unless the settlement was observed. If the
  facilitator returns an error, say so and stop.
- Do not touch the Ledger signing path, the subgraph, or history.js.
