// speculum — history
//
// The subgraph used to be write-only. Every verdict was indexed and nothing
// read the index to decide anything, which made it a dashboard. This module
// makes it load bearing: the gate reads the record over the network before it
// rules, and what it reads can change the ruling.
//
// Three things it asks, in one request:
//
//   the deed     has this exact calldata been judged before, and how
//   the agent    how often has this signer's declaration disagreed with its
//                bytes, across everything it has ever submitted
//   the parties  does the recipient or spender in this deed appear anywhere
//                in the record of blocked checks
//
// And one invariant the rest of the project already lives by: history can
// escalate a verdict and can never soften one. A clean record does not make
// bad bytes good. A prior human override on the same bytes does not carry
// forward, because that approval was bound to one moment and one declaration.
// Only the merits of the bytes can produce a PASS; history can only take one
// away.
//
// When the record cannot be read the gate says so. A verdict computed without
// history and presented as complete is exactly the class of lie this project
// exists to catch, so that path is refused rather than fallen back to.

import { Level } from './types.js';

/** The deployed subgraph, Base Sepolia, Subgraph Studio. Override with SUBGRAPH_URL. */
export const DEFAULT_SUBGRAPH_URL =
  'https://api.studio.thegraph.com/query/1758736/speculum/v0.0.1';

/** Raised by the reader for any reason the record could not be read. */
export class HistoryUnavailable extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'HistoryUnavailable';
  }
}

/**
 * A reader over a Graph query endpoint.
 *
 * The Studio endpoint this project deploys to answers without a key; that
 * was established by calling it, not assumed. The production gateway does
 * need one, and there the key is part of the URL path. Both are supported:
 * the key comes from SUBGRAPH_API_KEY or the option, is sent as a bearer
 * header, and is never placed in an error message or a log line. describe()
 * exists so a caller can print where it is reading from without printing a
 * key embedded in the path.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.url]        defaults to SUBGRAPH_URL, then the deployed endpoint
 * @param {string}  [opts.apiKey]     defaults to SUBGRAPH_API_KEY; null means none
 * @param {function}[opts.fetchImpl]  injectable, for tests and for a network that is down
 * @param {number}  [opts.timeoutMs]  a hung request is a failed request
 */
export function subgraphReader(opts = {}) {
  const url = opts.url ?? process.env.SUBGRAPH_URL ?? DEFAULT_SUBGRAPH_URL;
  const apiKey = opts.apiKey === undefined ? (process.env.SUBGRAPH_API_KEY ?? null) : opts.apiKey;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8_000;

  // Anything that leaves this function as text goes through here first.
  const redact = (s) => (apiKey ? String(s).split(apiKey).join('<key>') : String(s));

  return {
    describe() {
      return redact(url);
    },
    usesKey: apiKey != null,

    async query(query, variables = {}) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      const headers = { 'content-type': 'application/json' };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;

      let res;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ query, variables }),
          signal: ctl.signal,
        });
      } catch (err) {
        const why = err?.name === 'AbortError' ? `no answer within ${timeoutMs}ms` : (err?.cause?.message ?? err?.message ?? err);
        throw new HistoryUnavailable(`subgraph unreachable: ${redact(why)}`);
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) throw new HistoryUnavailable(`subgraph returned HTTP ${res.status}`);

      let body;
      try {
        body = await res.json();
      } catch {
        throw new HistoryUnavailable('subgraph answered with something that is not JSON');
      }
      if (body.errors?.length) {
        throw new HistoryUnavailable(
          `subgraph query failed: ${redact(body.errors.map((e) => e.message).join('; '))}`,
        );
      }
      if (!body.data) throw new HistoryUnavailable('subgraph answered with no data');
      return body.data;
    },
  };
}

/**
 * The one query. Aliased so a single round trip answers every question, and
 * built rather than static only because an empty `_in` list is a thing this
 * code should not have to know graph-node's opinion of.
 */
function buildQuery(withParties) {
  return `query History($deed: Bytes!, $agent: Bytes!${withParties ? ', $parties: [Bytes!]!' : ''}) {
  deed: checks(where: { deedHash: $deed }, orderBy: blockNumber, orderDirection: desc, first: 100) {
    level findings irreversible blockNumber agent { id }
  }
  deedNotPassed: checks(where: { deedHash: $deed, level_not: "PASS" }, first: 1) { level }
  deedOverrides: overrides(where: { deedHash: $deed }, first: 100) { blockNumber approver }
  agent: agents(where: { id: $agent }, first: 1) {
    checks passed blocked refused divergenceRate overridden undeclared
  }${withParties ? `
  partyAsAgent: agents(where: { id_in: $parties, blocked_gt: 0 }, first: 100) { id blocked }
  partyAsTarget: checks(where: { target_in: $parties, level: "BLOCK" }, first: 100) { target findings blockNumber }` : ''}
  _meta { block { number } hasIndexingErrors }
}`;
}

const lower = (s) => String(s).toLowerCase();

/**
 * Read the record for one check. Never throws: a failure to read is itself
 * the answer, and it comes back as `available: false` with the reason so the
 * gate can rule UNDETERMINED rather than rule without it.
 *
 * @param {{query: function}} reader
 * @param {{deedHash: string, agent: string, counterparties?: string[]}} q
 */
export async function readHistory(reader, { deedHash, agent, counterparties = [] }) {
  const parties = [...new Set(counterparties.map(lower))];
  const t0 = performance.now();
  const latency = () => Math.round(performance.now() - t0);

  let data;
  try {
    const vars = { deed: lower(deedHash), agent: lower(agent) };
    if (parties.length) vars.parties = parties;
    data = await reader.query(buildQuery(parties.length > 0), vars);
  } catch (err) {
    return { consulted: true, available: false, reason: String(err?.message ?? err), latencyMs: latency() };
  }

  // A subgraph that reports indexing errors is a record with holes in it,
  // and a hole is indistinguishable from an absence. Refuse rather than rule
  // on a record that admits it is incomplete.
  if (!data._meta?.block?.number) {
    return { consulted: true, available: false, reason: 'subgraph answered without _meta', latencyMs: latency() };
  }
  if (data._meta.hasIndexingErrors) {
    return { consulted: true, available: false, reason: 'subgraph reports indexing errors', latencyMs: latency() };
  }

  const checks = data.deed ?? [];
  const count = (lvl) => checks.filter((c) => c.level === lvl).length;
  const a = data.agent?.[0] ?? null;

  const partyRecord = {};
  for (const p of parties) partyRecord[p] = { asAgentBlocked: 0, asTargetBlocked: 0, findings: [] };
  for (const row of data.partyAsAgent ?? []) {
    const p = partyRecord[lower(row.id)];
    if (p) p.asAgentBlocked = Number(row.blocked);
  }
  for (const row of data.partyAsTarget ?? []) {
    const p = partyRecord[lower(row.target)];
    if (!p) continue;
    p.asTargetBlocked += 1;
    for (const f of row.findings) if (!p.findings.includes(f)) p.findings.push(f);
  }

  return {
    consulted: true,
    available: true,
    latencyMs: latency(),
    indexedBlock: Number(data._meta.block.number),
    deed: {
      prior: checks.length,
      passed: count(Level.PASS),
      blocked: count(Level.BLOCK),
      refused: count(Level.REFUSE),
      // Answered by its own query rather than by counting the capped list, so
      // a deed judged more than a hundred times still cannot hide a block
      // past the cap.
      everNotPassed: (data.deedNotPassed ?? []).length > 0,
      overrides: (data.deedOverrides ?? []).length,
      last: checks[0] ? { level: checks[0].level, findings: checks[0].findings, block: Number(checks[0].blockNumber) } : null,
    },
    agent: a
      ? {
          known: true,
          checks: Number(a.checks),
          passed: Number(a.passed),
          blocked: Number(a.blocked),
          refused: Number(a.refused),
          divergenceRate: Number(a.divergenceRate),
          overridden: Number(a.overridden),
          undeclared: Number(a.undeclared),
        }
      : { known: false },
    parties: partyRecord,
  };
}

/**
 * Every address in a deed that receives value or is granted allowance.
 * Batches contribute the parties of every leaf leg. The signer is excluded:
 * its own record is the agent's, and is judged by the agent rule.
 */
export function counterpartiesOf(deed, agent) {
  const out = new Set();
  const take = (d) => {
    for (const k of ['recipient', 'spender']) if (d?.[k]) out.add(lower(d[k]));
    for (const k of ['recipients', 'spenders']) for (const v of d?.[k] ?? []) out.add(lower(v));
    for (const leg of d?.legs ?? []) take(leg);
  };
  take(deed);
  if (agent) out.delete(lower(agent));
  return [...out];
}
