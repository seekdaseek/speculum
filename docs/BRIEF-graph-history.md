# Brief: make The Graph load-bearing in the gate

The brief this round of work was built against, kept verbatim because ETHGlobal
asks that spec files and prompts be in the repository when AI tooling is used.
Received Sep 7, 2026.

---

Make The Graph load-bearing in the gate. Right now speculum only WRITES verdicts to its subgraph; nothing reads them to decide anything. The Graph's ETHOnline track requires the project to consume live data from a Graph provider and do meaningful work with it — reasoning, decisions, automation — not print a query result. Mocked, local-only or static data explicitly does not qualify.

Build a history layer that changes the verdict.

1. A reader module that queries the deployed subgraph at https://api.studio.thegraph.com/query/1758736/speculum/v0.0.1 over the network. Establish by running whether that endpoint needs a Subgraph Studio API key; if it does, read the key from env only, never hardcode, never print it. Report what you observed.

2. The gate consults history before it rules, on at least: prior verdicts for this deed hash, prior verdicts for this agent, and whether this recipient or spender has appeared in a BLOCK before.

3. History must be able to CHANGE the outcome, or this is decoration. At minimum: a repeat of a deed hash previously blocked escalates rather than passing on its own merits, and an agent with a prior divergence rate above a stated threshold gets its borderline calls escalated. Pick the rules deliberately and write down why each one exists.

4. Refusal discipline holds. If the subgraph is unreachable or the query fails, the verdict is UNDETERMINED-ON-HISTORY and says so. Never silently fall back to a no-history decision and present it as a full one — that is the exact failure this project exists to catch.

5. Never let history alone create a PASS. History can only escalate, never soften. State that as an invariant and test it.

6. Tests for each rule, plus the failure path with the network down.

7. README: a section on what the subgraph is used for now, with the observed query latency and a real example of a verdict that changed because of history.

Commit per piece in the repo's register, no Co-Authored-By, then push and print git log -1 --oneline origin/main.
