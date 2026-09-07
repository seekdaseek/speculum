// speculum — history tests
//
// A scripted reader stands in for the subgraph so each rule is exercised on a
// record chosen to trigger it, or chosen not to. The network-down case is not
// scripted: it opens a real socket to a port nothing listens on. The one
// property that matters above the rules is at the end: across every record
// this file can produce, history never lowers a verdict.

import { encodeFunctionData, encodeAbiParameters, getAddress } from 'viem';
import { Gate } from '../src/gate.js';
import { Level } from '../src/types.js';
import { ABI } from '../src/decode.js';
import { subgraphReader, readHistory, counterpartiesOf, HistoryUnavailable } from '../src/history.js';
import { judge, borderline, HistoryFinding, HISTORY_LEVEL, UNDETERMINED, DEFAULT_POLICY } from '../src/policy.js';

const USDC = getAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
const WETH = getAddress('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
const ROUTER = getAddress('0xE592427A0AEce92De3Edee1F18E0157C05861564');
const AGENT = getAddress('0xc50d7cfd53542c9266a71e499548674c006354f6');
const THEM = getAddress('0x000000000000000000000000000000000000dEaD');
const OTHER = getAddress('0x1111111111111111111111111111111111111111');
const MAX = (1n << 256n) - 1n;

const call = (n, a) => encodeFunctionData({ abi: ABI, functionName: n, args: a });
const bytes = (arr) => encodeAbiParameters([{ type: 'bytes[]' }], [arr]);

let pass = 0, fail = 0;
const out = [];
const check = (n, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  out.push(`${ok ? 'ok  ' : 'FAIL'}  ${n}${ok ? '' : `   got ${got}, want ${want}`}`);
};
const has = (r, code) => r.findings.some((f) => f.code === code);

// ------------------------------------------------------------ fixtures
// Raw GraphQL data, shaped as the subgraph answers, so the shaping code in
// readHistory is under test too and not just the rules behind it.
const agentRow = ({ checks = 18, passed = 3, blocked = 12, refused = 3, overridden = 0 } = {}) => ({
  checks: String(checks), passed: String(passed), blocked: String(blocked), refused: String(refused),
  divergenceRate: String((blocked + refused) / checks), overridden: String(overridden), undeclared: '0',
});
const checkRow = (level, findings = [], blockNumber = 1) => ({
  level, findings, irreversible: false, blockNumber: String(blockNumber), agent: { id: AGENT.toLowerCase() },
});
function record({ deed = [], overrides = 0, agent = null, partyAgents = [], partyTargets = [], indexingErrors = false, meta = true } = {}) {
  const data = {
    deed,
    deedNotPassed: deed.filter((c) => c.level !== 'PASS').slice(0, 1),
    deedOverrides: Array.from({ length: overrides }, (_, i) => ({ blockNumber: String(i), approver: AGENT.toLowerCase() })),
    agent: agent ? [agent] : [],
    partyAsAgent: partyAgents,
    partyAsTarget: partyTargets,
  };
  if (meta) data._meta = { block: { number: '46506528' }, hasIndexingErrors: indexingErrors };
  return data;
}
const scripted = (data) => ({ query: async () => data, describe: () => 'scripted', usesKey: false });
const broken = (msg = 'boom') => ({ query: async () => { throw new HistoryUnavailable(msg); }, describe: () => 'broken', usesKey: false });

const CLEAN = record({ agent: agentRow({ checks: 18, passed: 18, blocked: 0, refused: 0 }) });
const DEED_BLOCKED = record({
  deed: [checkRow('PASS'), checkRow('BLOCK', ['RECIPIENT_MISMATCH']), checkRow('PASS')],
  overrides: 2,
  agent: agentRow({ checks: 18, passed: 18, blocked: 0, refused: 0 }),
});
const DEED_REFUSED = record({ deed: [checkRow('REFUSE', ['UNKNOWN_SELECTOR'])], agent: agentRow() });
const DEED_PASSED = record({ deed: [checkRow('PASS'), checkRow('PASS')], agent: agentRow({ checks: 18, passed: 18, blocked: 0, refused: 0 }) });
const DIVERGENT = record({ agent: agentRow() });                                  // 15/18 = 0.83
const DIVERGENT_THIN = record({ agent: agentRow({ checks: 4, passed: 0, blocked: 4, refused: 0 }) });   // rate 1.0, 4 checks
const AT_THRESHOLD = record({ agent: agentRow({ checks: 10, passed: 5, blocked: 5, refused: 0 }) });   // rate 0.5 exactly
const PARTY_AGENT = record({ agent: agentRow({ checks: 18, passed: 18, blocked: 0, refused: 0 }),
  partyAgents: [{ id: THEM.toLowerCase(), blocked: '3' }] });
const PARTY_TARGET = record({ agent: agentRow({ checks: 18, passed: 18, blocked: 0, refused: 0 }),
  partyTargets: [{ target: ROUTER.toLowerCase(), findings: ['RECIPIENT_MISMATCH'], blockNumber: '5' }] });

// ------------------------------------------------------------ transactions
const honestTx = { to: USDC, data: call('transfer', [THEM, 100n]), value: 0n, chainId: 1 };
const fullIntent = { action: 'transfer', chainId: 1, token: USDC, amount: 100n, recipient: THEM };
const sparseIntent = { action: 'transfer', chainId: 1, token: USDC, amount: 100n };   // recipient unclaimed
const badTx = { to: USDC, data: call('transfer', [OTHER, 100n]), value: 0n, chainId: 1 };
const junkTx = { to: USDC, data: '0xdeadbeef', value: 0n, chainId: 1 };
const approveTx = { to: USDC, data: call('approve', [ROUTER, 100n]), value: 0n, chainId: 1 };
const approveIntent = { action: 'approve', chainId: 1, token: USDC, amount: 100n, spender: ROUTER };
const gate = (data, policy) => new Gate({ history: scripted(data), historyPolicy: policy });
const run = (data, intent = fullIntent, tx = honestTx, policy) => gate(data, policy).check(intent, tx, { from: AGENT });

// ================================================================= the reader
// Scripted fetch: the reader is tested for what it sends and how it fails.
{
  let seen;
  const fetchOk = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ data: { x: 1 } }) }; };
  const r = subgraphReader({ url: 'https://example.invalid/q', apiKey: null, fetchImpl: fetchOk });
  const data = await r.query('{ x }', { a: 1 });
  check('reader posts JSON', seen.init.method === 'POST' && seen.init.headers['content-type'] === 'application/json', true);
  check('reader sends query and variables', JSON.parse(seen.init.body).variables.a, 1);
  check('reader returns data', data.x, 1);
  check('no key means no authorization header', seen.init.headers.authorization, undefined);
  check('reader reports no key', r.usesKey, false);
}
{
  const KEY = 'sk-do-not-print-this-anywhere';
  let seen;
  const fetchOk = async (url, init) => { seen = init; return { ok: true, status: 200, json: async () => ({ data: {} }) }; };
  const r = subgraphReader({ url: `https://gateway.example/api/${KEY}/subgraphs/id/abc`, apiKey: KEY, fetchImpl: fetchOk });
  await r.query('{ x }');
  check('key goes out as a bearer header', seen.headers.authorization, `Bearer ${KEY}`);
  check('describe() does not print the key', r.describe().includes(KEY), false);
  check('describe() still names the host', r.describe().startsWith('https://gateway.example/api/<key>/'), true);

  const leaky = async () => { throw new Error(`connect failed to /api/${KEY}/`); };
  const r2 = subgraphReader({ url: 'https://x/q', apiKey: KEY, fetchImpl: leaky });
  let msg = '';
  try { await r2.query('{ x }'); } catch (e) { msg = e.message; }
  check('a transport error that echoes the key is redacted', msg.includes(KEY), false);
  check('and still says what happened', msg.startsWith('subgraph unreachable:'), true);
}
{
  const cases = [
    ['HTTP 500', async () => ({ ok: false, status: 500, json: async () => ({}) }), 'subgraph returned HTTP 500'],
    ['HTTP 429', async () => ({ ok: false, status: 429, json: async () => ({}) }), 'subgraph returned HTTP 429'],
    ['graphql errors', async () => ({ ok: true, status: 200, json: async () => ({ errors: [{ message: 'Type Query has no field foo' }] }) }), 'subgraph query failed: Type Query has no field foo'],
    ['not json', async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } }), 'subgraph answered with something that is not JSON'],
    ['no data', async () => ({ ok: true, status: 200, json: async () => ({}) }), 'subgraph answered with no data'],
    ['thrown', async () => { throw new TypeError('fetch failed'); }, 'subgraph unreachable: fetch failed'],
  ];
  for (const [name, f, want] of cases) {
    const r = subgraphReader({ url: 'https://x/q', apiKey: null, fetchImpl: f });
    let err = null;
    try { await r.query('{ x }'); } catch (e) { err = e; }
    check(`reader: ${name} is HistoryUnavailable`, err instanceof HistoryUnavailable, true);
    check(`reader: ${name} says why`, err?.message, want);
  }
}
{
  // A request that never answers is a failed request, not a hung gate.
  const never = (_u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const r = subgraphReader({ url: 'https://x/q', apiKey: null, fetchImpl: never, timeoutMs: 30 });
  let err = null;
  try { await r.query('{ x }'); } catch (e) { err = e; }
  check('reader: timeout is HistoryUnavailable', err instanceof HistoryUnavailable, true);
  check('reader: timeout names the limit', err?.message, 'subgraph unreachable: no answer within 30ms');
}

// ======================================================= readHistory shaping
{
  const h = await readHistory(scripted(DEED_BLOCKED), { deedHash: '0xABC', agent: AGENT, counterparties: [THEM] });
  check('history available', h.available, true);
  check('deed counts', `${h.deed.prior}/${h.deed.passed}/${h.deed.blocked}/${h.deed.refused}`, '3/2/1/0');
  check('deed everNotPassed', h.deed.everNotPassed, true);
  check('deed overrides counted', h.deed.overrides, 2);
  check('agent shaped', h.agent.known && h.agent.checks === 18 && h.agent.divergenceRate === 0, true);
  check('party present with no record', h.parties[THEM.toLowerCase()].asAgentBlocked, 0);
  check('indexed block carried', h.indexedBlock, 46506528);
  check('latency measured', typeof h.latencyMs, 'number');
}
{
  let vars;
  const r = { query: async (_q, v) => { vars = v; return CLEAN; } };
  await readHistory(r, { deedHash: '0xABCDEF', agent: AGENT, counterparties: [THEM, THEM.toLowerCase()] });
  check('deed hash sent lowercase', vars.deed, '0xabcdef');
  check('agent sent lowercase', vars.agent, AGENT.toLowerCase());
  check('parties deduplicated case-insensitively', vars.parties.length, 1);
  await readHistory(r, { deedHash: '0x1', agent: AGENT, counterparties: [] });
  check('no parties means no parties variable', 'parties' in vars, false);
}
{
  check('unknown agent shaped as unknown', (await readHistory(scripted(record()), { deedHash: '0x1', agent: OTHER })).agent.known, false);
  check('indexing errors make it unavailable', (await readHistory(scripted(record({ indexingErrors: true })), { deedHash: '0x1', agent: AGENT })).available, false);
  check('missing _meta makes it unavailable', (await readHistory(scripted(record({ meta: false })), { deedHash: '0x1', agent: AGENT })).available, false);
  const h = await readHistory(broken('subgraph returned HTTP 502'), { deedHash: '0x1', agent: AGENT });
  check('reader failure is caught, not thrown', h.available, false);
  check('and the reason survives', h.reason, 'subgraph returned HTTP 502');
}

// =========================================================== counterparties
{
  check('transfer recipient is a party', counterpartiesOf({ recipient: THEM }, AGENT)[0], THEM.toLowerCase());
  check('approve spender is a party', counterpartiesOf({ spender: ROUTER }, AGENT)[0], ROUTER.toLowerCase());
  check('the signer is not its own counterparty', counterpartiesOf({ recipient: AGENT }, AGENT).length, 0);
  const batch = { legs: [{ spender: ROUTER }, { legs: [{ recipient: THEM }] }], recipients: [THEM], spenders: [ROUTER] };
  check('batch parties come from every leaf', counterpartiesOf(batch, AGENT).length, 2);
}

// ================================================================ borderline
{
  const deed = { recipient: THEM, asset: USDC, amount: 100n, chainId: 1 };
  check('a full-field intent is not borderline', borderline(fullIntent, deed).length, 0);
  check('an unclaimed recipient is', borderline(sparseIntent, deed).join(), 'recipient undeclared');
  check('an unclaimed amount is', borderline({ action: 'transfer', chainId: 1, token: USDC, recipient: THEM }, deed).join(), 'amount undeclared');
  check('tolerance slack is', borderline(fullIntent, { ...deed, amount: 101n }).join(), 'passed on tolerance');
  check('a batch is', borderline({ action: ['approve', 'swap'], chainId: 1, token: USDC, amount: 1n, spender: ROUTER, recipient: THEM },
    { legs: [{ spender: ROUTER, asset: USDC, amount: 1n }] }).join(), 'batch');
  check('unclaimed spender is', borderline({ action: 'approve', chainId: 1, token: USDC, amount: 100n }, { spender: ROUTER, asset: USDC, amount: 100n }).join(), 'spender undeclared');
  check('reasons stack', borderline({ action: 'transfer' }, deed).length, 4);
}

// ================================================= rule 1: repeat of a blocked deed
{
  const r = await run(DEED_BLOCKED);
  check('R1: merits pass on their own', r.merits.level, Level.PASS);
  check('R1: history escalates the same bytes', r.level, Level.BLOCK);
  check('R1: verdict is BLOCK not undetermined', r.verdict, Level.BLOCK);
  check('R1: names the finding', has(r, HistoryFinding.HISTORY_REPEAT_OF_BLOCKED_DEED), true);
  check('R1: needs a human now', r.needsHuman, true);
  const f = r.findings.find((x) => x.code === HistoryFinding.HISTORY_REPEAT_OF_BLOCKED_DEED);
  check('R1: detail carries the counts', f.detail.startsWith('judged 3 time(s) before: 2 passed, 1 blocked, 0 refused'), true);
  check('R1: prior overrides are named as not carrying forward', f.detail.includes('2 human override(s), which do not carry forward'), true);
}
{
  check('R1: a prior refusal escalates too', (await run(DEED_REFUSED)).level, Level.BLOCK);
  check('R1: prior passes alone do not escalate', (await run(DEED_PASSED)).level, Level.PASS);
  check('R1: a never-seen deed does not escalate', (await run(CLEAN)).level, Level.PASS);
}
{
  // The cap on the listed checks cannot hide a block: the escalation reads
  // its own single-row query, not the capped list.
  const data = record({ deed: Array.from({ length: 100 }, () => checkRow('PASS')), agent: agentRow({ checks: 1, passed: 1, blocked: 0, refused: 0 }) });
  data.deedNotPassed = [{ level: 'BLOCK' }];
  check('R1: a block past the list cap still escalates', (await run(data)).level, Level.BLOCK);
}

// ================================================== rule 2: divergent agent
{
  const r = await run(DIVERGENT, sparseIntent);
  check('R2: borderline pass by a divergent agent escalates', r.level, Level.BLOCK);
  check('R2: names the finding', has(r, HistoryFinding.HISTORY_AGENT_DIVERGENT), true);
  const f = r.findings.find((x) => x.code === HistoryFinding.HISTORY_AGENT_DIVERGENT);
  check('R2: detail states the rate, the threshold and the weakness',
    f.detail, 'agent diverged on 15 of 18 checks (rate 0.83, threshold 0.5); this pass rests on: recipient undeclared');
}
{
  check('R2: a full-field pass by the same agent still passes', (await run(DIVERGENT, fullIntent)).level, Level.PASS);
  check('R2: below minChecks the rate means nothing yet', (await run(DIVERGENT_THIN, sparseIntent)).level, Level.PASS);
  check('R2: a rate exactly at the threshold does not trip it', (await run(AT_THRESHOLD, sparseIntent)).level, Level.PASS);
  check('R2: an unknown agent is not divergent', (await run(record(), sparseIntent)).level, Level.PASS);
  check('R2: a clean agent keeps its borderline pass', (await run(CLEAN, sparseIntent)).level, Level.PASS);
  check('R2: policy is adjustable, threshold 0.4 trips the 0.5 agent',
    (await run(AT_THRESHOLD, sparseIntent, honestTx, { divergenceThreshold: 0.4 })).level, Level.BLOCK);
  check('R2: policy is adjustable, minChecks 3 trips the thin agent',
    (await run(DIVERGENT_THIN, sparseIntent, honestTx, { minChecks: 3 })).level, Level.BLOCK);
  check('R2: defaults are the stated ones', `${DEFAULT_POLICY.divergenceThreshold}/${DEFAULT_POLICY.minChecks}`, '0.5/5');
}
{
  // A batch counts as borderline for a divergent agent even when fully declared.
  // A multicall's legs are calls on the router itself, so the token the leg
  // moves is the router's own, and the declaration says so.
  const tx = { to: ROUTER, data: call('multicall', [[call('approve', [ROUTER, 100n])]]), value: 0n, chainId: 1 };
  const intent = { action: ['approve'], chainId: 1, token: ROUTER, amount: 100n, spender: ROUTER };
  const clean = await run(CLEAN, intent, tx);
  const div = await run(DIVERGENT, intent, tx);
  check('R2: batch passes on merits', clean.merits.level, Level.PASS);
  check('R2: batch by a divergent agent escalates', div.level, Level.BLOCK);
}

// ============================================ rule 3: counterparty in the record
{
  const r = await run(PARTY_AGENT);
  check('R3: recipient that is a blocked signer escalates', r.level, Level.BLOCK);
  check('R3: names the finding', has(r, HistoryFinding.HISTORY_COUNTERPARTY_BLOCKED), true);
  check('R3: detail names the address and the role',
    r.findings.find((x) => x.code === HistoryFinding.HISTORY_COUNTERPARTY_BLOCKED).detail,
    `${THEM.toLowerCase()} appears as a signer blocked 3 time(s)`);
}
{
  const r = await run(PARTY_TARGET, approveIntent, approveTx);
  check('R3: spender that was the target of a block escalates', r.level, Level.BLOCK);
  check('R3: detail names the role and the finding classes',
    r.findings.find((x) => x.code === HistoryFinding.HISTORY_COUNTERPARTY_BLOCKED).detail,
    `${ROUTER.toLowerCase()} appears as the target of 1 blocked check(s) [RECIPIENT_MISMATCH]`);
  check('R3: a party with no record does not escalate', (await run(CLEAN, approveIntent, approveTx)).level, Level.PASS);
}

// =================================== rule 4: the record cannot be read
{
  const r = await run(record(), fullIntent, honestTx);
  check('control: readable record passes the honest transfer', r.verdict, Level.PASS);
}
{
  const g = new Gate({ history: broken('subgraph returned HTTP 503') });
  const r = await g.check(fullIntent, honestTx, { from: AGENT });
  check('R4: verdict is UNDETERMINED-ON-HISTORY', r.verdict, UNDETERMINED);
  check('R4: level is REFUSE', r.level, Level.REFUSE);
  check('R4: finding is HISTORY_UNAVAILABLE', has(r, HistoryFinding.HISTORY_UNAVAILABLE), true);
  check('R4: the reason is carried', r.findings.find((f) => f.code === HistoryFinding.HISTORY_UNAVAILABLE).detail, 'subgraph returned HTTP 503');
  check('R4: merits are still reported, separately', r.merits.level, Level.PASS);
  check('R4: history says it was consulted and failed', r.history.consulted && !r.history.available, true);
}
{
  // Refusal on history holds when the bytes were already bad, too. It is
  // not a downgrade to BLOCK and not a silent BLOCK-on-merits.
  const r = await new Gate({ history: broken() }).check(fullIntent, badTx, { from: AGENT });
  check('R4: a merits BLOCK with unreadable history is still undetermined', r.verdict, UNDETERMINED);
  check('R4: and its merits block is preserved', r.merits.level, Level.BLOCK);
}
{
  // Network actually down: a real socket to a port nothing listens on, no
  // mock. This is the path a judge can reproduce by pulling the cable.
  const r = new Gate({ history: subgraphReader({ url: 'http://127.0.0.1:9/graphql', apiKey: null, timeoutMs: 3000 }) });
  const res = await r.check(fullIntent, honestTx, { from: AGENT });
  check('R4 live: connection refused gives UNDETERMINED-ON-HISTORY', res.verdict, UNDETERMINED);
  check('R4 live: says the subgraph was unreachable',
    res.findings.find((f) => f.code === HistoryFinding.HISTORY_UNAVAILABLE).detail.startsWith('subgraph unreachable:'), true);
  check('R4 live: the merits pass is not lost', res.merits.level, Level.PASS);
}
{
  const r = await new Gate({ history: scripted(record({ indexingErrors: true })) }).check(fullIntent, honestTx, { from: AGENT });
  check('R4: indexing errors are undetermined, not trusted', r.verdict, UNDETERMINED);
}
{
  let threw = null;
  try { await gate(CLEAN).check(fullIntent, honestTx); } catch (e) { threw = e.message; }
  check('history without a signing address throws rather than skipping the agent rule',
    threw, 'history needs the signing address: pass opts.from');
}

// ======================================= no reader configured is not a failure
{
  const r = await new Gate().check(fullIntent, honestTx);
  check('no reader: history not consulted, and says so', r.history.consulted, false);
  check('no reader: verdict equals level', r.verdict, r.level);
  check('no reader: merits equal the ruling', r.merits.level, r.level);
}

// ================================= the record written on chain is the merits
{
  const r = await run(DEED_BLOCKED);
  const rec = gate(DEED_BLOCKED).toRecord(r);
  check('toRecord writes the merits level, not the escalated one', rec.level, 0);
  check('toRecord writes no history bits', rec.findings, 0);
  check('so the contract invariant holds for the record', (rec.level === 0) === (rec.findings === 0), true);
  const b = await run(CLEAN, fullIntent, badTx);
  check('a merits block is still recorded as a block', gate(CLEAN).toRecord(b).level, 1);
}

// ================================= escalation carries the history reason
{
  let asked = null;
  const port = { async request(q) { asked = q; return OTHER; } };
  const g = new Gate({ history: scripted(DEED_BLOCKED), confirm: port });
  const r = await g.check(fullIntent, honestTx, { from: AGENT });
  await g.escalate(r);
  check('the device is asked with the history finding as the reason', asked.findings[0].code, HistoryFinding.HISTORY_REPEAT_OF_BLOCKED_DEED);
  check('and the approval binds to the bytes as before', g.authorise(honestTx).ok, true);
}

// ================================================= THE INVARIANT: never softer
// Every history this file knows how to produce, against every merits outcome.
// Rank must never go down. Also: nothing in the level table maps to PASS.
{
  check('no history finding maps to PASS', Object.values(HISTORY_LEVEL).includes(Level.PASS), false);
  const RANK = { PASS: 0, BLOCK: 1, REFUSE: 2 };
  const records = { CLEAN, DEED_BLOCKED, DEED_REFUSED, DEED_PASSED, DIVERGENT, DIVERGENT_THIN, AT_THRESHOLD, PARTY_AGENT, PARTY_TARGET,
    EMPTY: record(), INDEXING_ERRORS: record({ indexingErrors: true }) };
  const merits = [
    ['pass', fullIntent, honestTx], ['sparse pass', sparseIntent, honestTx], ['block', fullIntent, badTx],
    ['refuse', fullIntent, junkTx], ['approve', approveIntent, approveTx],
  ];
  let violations = 0, combos = 0;
  for (const [rname, data] of [...Object.entries(records), ['UNREADABLE', null]]) {
    for (const [mname, intent, tx] of merits) {
      const g = new Gate({ history: data ? scripted(data) : broken() });
      const r = await g.check(intent, tx, { from: AGENT });
      combos++;
      if (RANK[r.level] < RANK[r.merits.level]) { violations++; out.push(`      softened: ${rname} x ${mname}: ${r.merits.level} -> ${r.level}`); }
    }
  }
  check(`history never softens across ${combos} record x merits combinations`, violations, 0);
}
{
  // The two softening temptations, refused by name.
  const perfectAgent = record({ deed: [checkRow('PASS'), checkRow('PASS')], overrides: 5, agent: agentRow({ checks: 1000, passed: 1000, blocked: 0, refused: 0 }) });
  const r = await run(perfectAgent, fullIntent, badTx);
  check('a spotless agent record does not soften a merits block', r.level, Level.BLOCK);
  check('and a human still has to look', r.needsHuman, true);
  const r2 = await run(perfectAgent, fullIntent, junkTx);
  check('five prior overrides on the deed do not soften a refusal', r2.level, Level.REFUSE);
}

// ============================================================== rule interplay
{
  // Several rules firing produce several findings, and the ruling is the worst.
  const data = record({
    deed: [checkRow('BLOCK', ['RECIPIENT_MISMATCH'])], agent: agentRow(),
    partyAgents: [{ id: THEM.toLowerCase(), blocked: '1' }],
  });
  const r = await run(data, sparseIntent);
  const codes = r.findings.map((f) => f.code).sort().join(',');
  check('three rules can fire at once and all are reported', codes,
    [HistoryFinding.HISTORY_AGENT_DIVERGENT, HistoryFinding.HISTORY_COUNTERPARTY_BLOCKED, HistoryFinding.HISTORY_REPEAT_OF_BLOCKED_DEED].sort().join(','));
  check('and the ruling is BLOCK', r.level, Level.BLOCK);
  const j = judge({ available: false, reason: 'x' }, { merits: { level: Level.PASS }, intent: fullIntent, deed: {} });
  check('judge on an unavailable record raises exactly one finding', j.findings.length, 1);
}

console.log(out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
