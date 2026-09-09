// speculum — the root of the paid service, for people and for machines
//
// GET / has always answered with the service descriptor as JSON, and agents
// parse it to find the price before spending anything. The ETHGlobal Live Demo
// button points at the same URL, so a judge in a browser landed on raw JSON.
//
// The fix is content negotiation, not a second URL. A client whose Accept
// header prefers text/html gets one self-contained page rendered from the
// same descriptor object; every other client gets the descriptor exactly as
// before. The descriptor is built here, once, so the two paths cannot drift:
// the page reads the object the JSON path serialises, never a copy of it.
//
// No script, no framework, no font or stylesheet fetched from anywhere. The
// page is a string and renders with JavaScript off.

/**
 * The service descriptor. Key order matters: it is the order the JSON has
 * always been emitted in, and a test pins the serialised bytes.
 */
export function describe({ network, facilitator, prices, audit, source }) {
  return {
    service: 'speculum',
    what: 'checks whether a declared intent matches the transaction about to be signed',
    endpoint: 'POST /check',
    payment: { protocol: 'x402', version: 2, network, facilitator },
    pricing: {
      unit: 'tinybar',
      metered: true,
      tiers: [
        { tier: 'decode', amount: prices.decode.toString(), covers: 'decode and compare' },
        { tier: 'simulated', amount: prices.simulated.toString(), covers: 'adds a live balance simulation' },
      ],
    },
    verdicts: ['PASS', 'BLOCK', 'REFUSE'],
    outcomes: ['match', 'divergence', 'undeterminable'],
    audit,
    source,
  };
}

/**
 * Does this Accept header prefer HTML over JSON?
 *
 * Proper media-range matching: the most specific range that covers a type
 * decides its quality, so `text/html;q=0.2, *\/*;q=0.8` still reads as html
 * at 0.2. A tie is not a preference: curl and fetch send `*\/*`, which covers
 * both types equally, and they keep getting JSON. No header means JSON.
 */
export function prefersHtml(accept) {
  if (!accept) return false;
  const best = { html: { q: 0, s: -1 }, json: { q: 0, s: -1 } };
  for (const part of String(accept).split(',')) {
    const [range, ...params] = part.split(';').map((x) => x.trim());
    if (!range) continue;
    let q = 1;
    for (const p of params) {
      const m = /^q=([0-9]*\.?[0-9]+)$/i.exec(p);
      if (m) q = Math.min(1, Math.max(0, Number(m[1])));
    }
    const [type, sub] = range.toLowerCase().split('/');
    const consider = (key, t, s) => {
      let specificity;
      if (type === t && sub === s) specificity = 3;
      else if (type === t && sub === '*') specificity = 2;
      else if (type === '*' && (sub === '*' || sub === undefined)) specificity = 1;
      else return;
      if (specificity > best[key].s) best[key] = { q, s: specificity };
    };
    consider('html', 'text', 'html');
    consider('json', 'application', 'json');
  }
  return best.html.q > best.json.q;
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The unpaid request a reader can run without a wallet, and what it returned.
 * The response body is pasted from a real run against the live endpoint, not
 * composed; the date says when. Run it again and the fee payer may differ,
 * because the service reads it from the facilitator on every quote.
 */
export const CURL_EXAMPLE = {
  capturedOn: 'Sep 9 2026',
  command: [
    "curl -sS -X POST https://speculum.ochinimus.app/check \\",
    "  -H 'content-type: application/json' \\",
    "  -d '{\"intent\":{\"action\":\"approve\",\"chainId\":1,\"token\":\"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48\",\"amount\":\"100000000\",\"spender\":\"0xE592427A0AEce92De3Edee1F18E0157C05861564\"},\"tx\":{\"to\":\"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48\",\"data\":\"0x095ea7b3000000000000000000000000e592427a0aece92de3edee1f18e0157c05861564ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\",\"value\":\"0\",\"chainId\":1}}' \\",
    "  -w '\\nHTTP %{http_code}\\n'",
  ].join('\n'),
  output: [
    '{"x402Version":2,"error":"payment required","accepts":[{"scheme":"exact","network":"hedera:testnet","amount":"100000","payTo":"0.0.10386821","maxTimeoutSeconds":300,"asset":"0.0.0","extra":{"feePayer":"0.0.7162784"},"resource":"/check?tier=decode","description":"intent versus calldata"}]}',
    'HTTP 402',
  ].join('\n'),
};

const VERDICT_MEANING = {
  PASS: 'the bytes do what the agent said, within tolerance, and nothing irreversible was undeclared',
  BLOCK: 'the bytes and the declaration disagree, or the action cannot be undone; a human is needed',
  REFUSE: 'the effect could not be determined, so the service does not guess',
};

/**
 * One page, from the descriptor. Every value that came from the descriptor
 * is escaped on the way in; the only raw HTML is this template.
 */
export function renderPage(d, { curl = CURL_EXAMPLE, publicUrl = 'https://speculum.ochinimus.app' } = {}) {
  const e = escapeHtml;
  const tiers = d.pricing.tiers.map((t) => `
        <tr><td><code>${e(t.tier)}</code></td><td class="num">${e(Number(t.amount).toLocaleString('en-US'))}</td><td class="num">${e((Number(t.amount) / 1e8).toString())}</td><td>${e(t.covers)}</td></tr>`).join('');
  const verdicts = d.verdicts.map((v, i) => `
        <tr><td><code>${e(v)}</code></td><td>${e(d.outcomes[i] ?? '')}</td><td>${e(VERDICT_MEANING[v] ?? '')}</td></tr>`).join('');
  const audit = d.audit?.hcs
    ? `Every paid verdict is written to Hedera Consensus Service topic <code>${e(d.audit.topic)}</code>: the hash of the declared intent, the hash of the transaction, the verdict, the finding codes, and the settlement that paid for it. The topic has no submit key, so anyone can <a href="${e(d.audit.mirror)}">read it on the public mirror node</a> with no key and no account, or run <code>node hedera/audit-verify.js ${e(d.audit.topic)}</code> to check every settlement against the ledger.`
    : `The audit trail is off on this instance${d.audit?.reason ? ` (${e(d.audit.reason)})` : ''}. When it is on, every paid verdict is written to a Hedera Consensus Service topic anyone can read.`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(d.service)}</title>
<style>
  :root { color-scheme: dark; }
  html { background: #0b0d12; color: #e6e8ee; font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  body { margin: 0; padding: 2.5rem 1.25rem 4rem; }
  main { max-width: 56rem; margin: 0 auto; }
  h1 { font-size: 2rem; margin: 0 0 .25rem; letter-spacing: -.01em; }
  h1 small { font-size: .95rem; font-weight: 400; color: #9aa3b2; margin-left: .6rem; }
  .lede { font-size: 1.15rem; color: #c9cfdb; margin: 0 0 2rem; }
  h2 { font-size: 1.15rem; margin: 2.25rem 0 .6rem; color: #f3f4f7; }
  p { margin: .5rem 0; }
  a { color: #7cc4ff; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .92em; }
  code { background: #151923; padding: .1em .35em; border-radius: .3em; }
  pre { background: #0f131b; border: 1px solid #222838; border-radius: .5rem; padding: 1rem; overflow-x: auto; white-space: pre; line-height: 1.45; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: .5rem 0 1rem; }
  th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid #222838; vertical-align: top; }
  th { color: #9aa3b2; font-weight: 600; font-size: .85rem; text-transform: uppercase; letter-spacing: .04em; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .facts { display: grid; grid-template-columns: max-content 1fr; gap: .35rem 1.25rem; margin: .75rem 0 0; }
  .facts dt { color: #9aa3b2; }
  .facts dd { margin: 0; }
  .muted { color: #9aa3b2; font-size: .92rem; }
  footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #222838; color: #9aa3b2; font-size: .9rem; }
</style>
</head>
<body>
<main>
  <h1>${e(d.service)}<small>an approval gate, sold by the call</small></h1>
  <p class="lede">${e(d.what)}.</p>
  <p>An agent declares what it is about to do. The gate decodes the calldata on its own, derives what the bytes actually do, and compares the two. The agent pays per check and gets a verdict, not a guess.</p>

  <h2>Endpoint</h2>
  <dl class="facts">
    <dt>call</dt><dd><code>${e(d.endpoint)}</code> with <code>{ intent, tx }</code></dd>
    <dt>payment</dt><dd><code>${e(d.payment.protocol)}</code> v${e(d.payment.version)} on <code>${e(d.payment.network)}</code>, settled through the Blocky402 facilitator at <a href="${e(d.payment.facilitator)}/supported">${e(d.payment.facilitator)}</a></dd>
    <dt>unpaid</dt><dd><code>402</code> with the payment challenge</dd>
    <dt>paid</dt><dd>the verdict, the findings, the effects the decoder derived, both hashes, the settlement, and the audit record</dd>
  </dl>

  <h2>Price per call</h2>
  <p class="muted">${d.pricing.metered ? 'Metered, not flat: a decode-only check is pure computation, a simulated one costs a round trip against live chain state.' : ''} Unit: ${e(d.pricing.unit)}.</p>
  <table>
    <thead><tr><th>tier</th><th class="num">${e(d.pricing.unit)}</th><th class="num">HBAR</th><th>covers</th></tr></thead>
    <tbody>${tiers}
    </tbody>
  </table>

  <h2>Three verdicts</h2>
  <table>
    <thead><tr><th>verdict</th><th>outcome</th><th>meaning</th></tr></thead>
    <tbody>${verdicts}
    </tbody>
  </table>
  <p class="muted"><code>REFUSE</code> outranks <code>BLOCK</code> on purpose. A call that cannot be decoded is worse than a mismatch that can, because a mismatch is at least understood.</p>

  <h2>Audit trail</h2>
  <p>${audit}</p>

  <h2>See the paywall without a wallet</h2>
  <p>An unpaid request. Copy it, run it, and the service answers with the price and the facilitator's fee payer rather than a verdict:</p>
  <pre><code>${e(curl.command)}</code></pre>
  <p class="muted">What that command returned on ${e(curl.capturedOn)}, pasted, not composed:</p>
  <pre><code>${e(curl.output)}</code></pre>
  <p class="muted">Run it again and the fee payer may differ; the service reads it from the facilitator on every quote rather than caching it.</p>

  <footer>
    <p>Machines get JSON at this same URL: <code>curl -H 'Accept: application/json' ${e(publicUrl)}/</code>. Liveness at <a href="${e(publicUrl)}/health">/health</a>.</p>
    <p>Source, tests and the briefs this was built against: <a href="${e(d.source)}">${e(d.source)}</a>. Built at ETHOnline 2026.</p>
  </footer>
</main>
</body>
</html>
`;
}
