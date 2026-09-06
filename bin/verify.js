#!/usr/bin/env node
// speculum — verify the indexed record
//
// Reads the live subgraph and asserts the things that must be true. This
// exists because twice in a row a defect survived review by looking plausible:
// a field resolved to a value, the value was wrong, and nobody was checking the
// value. Counting entities is not verification. These are the assertions.
//
//   node bin/verify.js
//
// Exits non-zero on any violation, so it can gate a commit.

const ENDPOINT =
  process.env.SUBGRAPH_URL ??
  'https://api.studio.thegraph.com/query/1758736/speculum/v0.0.2';

const QUERY = `{
  agents { id checks passed blocked refused overridden declarations undeclared divergenceRate }
  checks(first: 500) { id level levelCode findings irreversible declaredFirst }
  overrides(first: 500, orderBy: blockNumber) {
    id unchecked blockNumber
    check { id level findings irreversible }
  }
  findingCounts { id count irreversible }
}`;

const res = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ query: QUERY }),
});
const body = await res.json();
if (body.errors) {
  console.error('query failed:', JSON.stringify(body.errors));
  process.exit(1);
}

const { agents, checks, overrides, findingCounts } = body.data;

let failures = 0;
const assert = (ok, name, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) failures++;
};

const IRREVERSIBLE = new Set([
  'UNBOUNDED_APPROVAL', 'APPROVAL_FOR_ALL', 'OWNERSHIP_TRANSFER',
  'PROXY_UPGRADE', 'SELF_DESTRUCT',
]);

// --- the contract's own invariant, seen from the other side -----------------
{
  const bad = checks.filter((c) => (c.level === 'PASS') !== (c.findings.length === 0));
  assert(bad.length === 0, 'a clean verdict never carries findings, and vice versa',
    bad.map((c) => `${c.id} ${c.level} [${c.findings}]`).join('\n        '));
}

// --- irreversibility is derived, not asserted -------------------------------
{
  const bad = checks.filter((c) => c.irreversible !== c.findings.some((f) => IRREVERSIBLE.has(f)));
  assert(bad.length === 0, 'irreversible is true exactly when an irreversible finding is present',
    bad.map((c) => `${c.id} irreversible=${c.irreversible} [${c.findings}]`).join('\n        '));
}

// --- THE ASSERTION THAT WOULD HAVE CAUGHT BOTH DEFECTS ----------------------
// A human is only ever asked about a verdict that needed a human. An override
// pointing at a PASS means either the link is wrong or something escalated
// that should not have.
{
  const linked = overrides.filter((o) => !o.unchecked && o.check);
  const bad = linked.filter((o) => o.check.level !== 'BLOCK' && !o.check.irreversible);
  assert(bad.length === 0, 'every resolved override answers a verdict that needed a human',
    bad.map((o) => `override at block ${o.blockNumber} -> ${o.check.level} [${o.check.findings}]`).join('\n        '));
}

// --- an unresolved override is a gate bypass, and must be rare and explained -
{
  const orphan = overrides.filter((o) => o.unchecked);
  assert(orphan.length === 0, 'no override answers a deed the gate never checked',
    `${orphan.length} override(s) with no matching check — that means something reached a signer around the gate`);
}

// --- per-agent arithmetic ---------------------------------------------------
for (const a of agents) {
  const total = Number(a.passed) + Number(a.blocked) + Number(a.refused);
  assert(total === Number(a.checks), `agent ${a.id.slice(0, 10)} counts reconcile`,
    `passed ${a.passed} + blocked ${a.blocked} + refused ${a.refused} = ${total}, checks = ${a.checks}`);

  const expected = (Number(a.blocked) + Number(a.refused)) / Number(a.checks);
  const stored = Number(a.divergenceRate);
  assert(Math.abs(expected - stored) < 1e-12, `agent ${a.id.slice(0, 10)} divergence rate matches`,
    `stored ${stored}, computed ${expected}`);

  assert(Number(a.overridden) <= Number(a.blocked), `agent ${a.id.slice(0, 10)} overrides do not exceed blocks`,
    `overridden ${a.overridden} > blocked ${a.blocked}`);
}

// --- totals across entities agree -------------------------------------------
{
  const fromChecks = {};
  for (const c of checks) for (const f of c.findings) fromChecks[f] = (fromChecks[f] ?? 0) + 1;
  const bad = findingCounts.filter((fc) => (fromChecks[fc.id] ?? 0) !== Number(fc.count));
  assert(bad.length === 0, 'finding counters match the checks that produced them',
    bad.map((fc) => `${fc.id} counter=${fc.count} actual=${fromChecks[fc.id] ?? 0}`).join('\n        '));

  const badFlag = findingCounts.filter((fc) => fc.irreversible !== IRREVERSIBLE.has(fc.id));
  assert(badFlag.length === 0, 'finding counters carry the right irreversible flag',
    badFlag.map((fc) => fc.id).join(', '));
}

console.log(`\n${checks.length} checks, ${overrides.length} overrides, ${agents.length} agent(s)`);
console.log(failures ? `\n${failures} VIOLATION(S)` : '\nall invariants hold');
process.exit(failures ? 1 : 0);
