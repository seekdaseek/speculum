// speculum — landing page and descriptor tests
//
// GET / now negotiates. The JSON path must be the bytes agents have always
// parsed, so the two descriptor variants are pinned here as literal strings
// captured from the server before negotiation was added: audit off, and audit
// on with the real topic. The negotiation itself is pure and is tested with
// the Accept headers real clients send. The page is checked for what it must
// carry and for what it must not: a script tag, an external fetch, an
// unescaped value.

import { describe, prefersHtml, renderPage, escapeHtml, CURL_EXAMPLE } from '../hedera/landing.js';
import { HEDERA_TESTNET_CAIP2 } from '@x402/hedera';

let pass = 0, fail = 0;
const out = [];
const check = (n, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  out.push(`${ok ? 'ok  ' : 'FAIL'}  ${n}${ok ? '' : `   got ${String(got).slice(0, 120)}, want ${String(want).slice(0, 120)}`}`);
};

const FACILITATOR = 'https://api.testnet.blocky402.com';
const PRICES = { decode: 100_000n, simulated: 500_000n };
const SOURCE = 'https://github.com/seekdaseek/speculum';
const MIRROR = 'https://testnet.mirrornode.hedera.com';
const auditOff = { hcs: false, reason: 'set HEDERA_OPERATOR_ID, HEDERA_OPERATOR_KEY and HEDERA_TOPIC_ID' };
const auditOn = { hcs: true, topic: '0.0.10422195', mirror: `${MIRROR}/api/v1/topics/0.0.10422195/messages` };
const cfg = (audit) => ({ network: HEDERA_TESTNET_CAIP2, facilitator: FACILITATOR, prices: PRICES, audit, source: SOURCE });

// ------------------------------------------- the JSON bytes, captured before
const GOLDEN_OFF = "{\"service\":\"speculum\",\"what\":\"checks whether a declared intent matches the transaction about to be signed\",\"endpoint\":\"POST /check\",\"payment\":{\"protocol\":\"x402\",\"version\":2,\"network\":\"hedera:testnet\",\"facilitator\":\"https://api.testnet.blocky402.com\"},\"pricing\":{\"unit\":\"tinybar\",\"metered\":true,\"tiers\":[{\"tier\":\"decode\",\"amount\":\"100000\",\"covers\":\"decode and compare\"},{\"tier\":\"simulated\",\"amount\":\"500000\",\"covers\":\"adds a live balance simulation\"}]},\"verdicts\":[\"PASS\",\"BLOCK\",\"REFUSE\"],\"outcomes\":[\"match\",\"divergence\",\"undeterminable\"],\"audit\":{\"hcs\":false,\"reason\":\"set HEDERA_OPERATOR_ID, HEDERA_OPERATOR_KEY and HEDERA_TOPIC_ID\"},\"source\":\"https://github.com/seekdaseek/speculum\"}";
const GOLDEN_ON = "{\"service\":\"speculum\",\"what\":\"checks whether a declared intent matches the transaction about to be signed\",\"endpoint\":\"POST /check\",\"payment\":{\"protocol\":\"x402\",\"version\":2,\"network\":\"hedera:testnet\",\"facilitator\":\"https://api.testnet.blocky402.com\"},\"pricing\":{\"unit\":\"tinybar\",\"metered\":true,\"tiers\":[{\"tier\":\"decode\",\"amount\":\"100000\",\"covers\":\"decode and compare\"},{\"tier\":\"simulated\",\"amount\":\"500000\",\"covers\":\"adds a live balance simulation\"}]},\"verdicts\":[\"PASS\",\"BLOCK\",\"REFUSE\"],\"outcomes\":[\"match\",\"divergence\",\"undeterminable\"],\"audit\":{\"hcs\":true,\"topic\":\"0.0.10422195\",\"mirror\":\"https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10422195/messages\"},\"source\":\"https://github.com/seekdaseek/speculum\"}";

check('descriptor bytes unchanged, audit off', JSON.stringify(describe(cfg(auditOff))), GOLDEN_OFF);
check('descriptor bytes unchanged, audit on', JSON.stringify(describe(cfg(auditOn))), GOLDEN_ON);
check('golden off is the pre-negotiation body length', Buffer.byteLength(GOLDEN_OFF), 687);
check('golden on is what the live endpoint served on Sep 9 2026', Buffer.byteLength(GOLDEN_ON), 719);

// ------------------------------------------------------- who gets the page
const CHROME = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
const FIREFOX = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
const SAFARI = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
check('chrome gets the page', prefersHtml(CHROME), true);
check('firefox gets the page', prefersHtml(FIREFOX), true);
check('safari gets the page', prefersHtml(SAFARI), true);
check('curl default */* gets JSON', prefersHtml('*/*'), false);
check('no Accept header gets JSON', prefersHtml(undefined), false);
check('empty Accept gets JSON', prefersHtml(''), false);
check('application/json gets JSON', prefersHtml('application/json'), false);
check('application/*;q=1 alongside text/html;q=0.5 gets JSON', prefersHtml('text/html;q=0.5, application/*'), false);
check('text/html alone gets the page', prefersHtml('text/html'), true);
check('a specific low html q is not rescued by a wildcard', prefersHtml('text/html;q=0.2, */*;q=0.8'), false);
check('json preferred by q gets JSON', prefersHtml('text/html;q=0.9, application/json'), false);
check('html preferred by q gets the page', prefersHtml('application/json;q=0.8, text/html'), true);
check('case and spacing do not matter', prefersHtml('TEXT/HTML ; q=1.0 ,  */* ; q=0.1'), true);

// ------------------------------------------------------------- the page
{
  const d = describe(cfg(auditOn));
  const html = renderPage(d);
  check('is a document', html.startsWith('<!doctype html>'), true);
  check('says what the service does', html.includes(escapeHtml(d.what)), true);
  check('names the endpoint', html.includes('POST /check'), true);
  check('names the payment protocol and version', html.includes('<code>x402</code> v2'), true);
  check('names the network', html.includes('<code>hedera:testnet</code>'), true);
  check('links the facilitator', html.includes(`<a href="${FACILITATOR}/supported">`), true);
  check('decode tier with its amount', html.includes('<code>decode</code></td><td class="num">100,000</td>'), true);
  check('decode tier with what it covers', html.includes('decode and compare'), true);
  check('simulated tier with its amount', html.includes('<code>simulated</code></td><td class="num">500,000</td>'), true);
  check('simulated tier with what it covers', html.includes('adds a live balance simulation'), true);
  for (const v of d.verdicts) check(`verdict ${v} listed`, html.includes(`<code>${v}</code>`), true);
  for (const o of d.outcomes) check(`outcome ${o} listed`, html.includes(`<td>${o}</td>`), true);
  check('names the topic', html.includes('<code>0.0.10422195</code>'), true);
  check('mirror link is an anchor', html.includes(`<a href="${auditOn.mirror}">`), true);
  check('carries the curl command', html.includes(escapeHtml(CURL_EXAMPLE.command)), true);
  check('carries the captured 402 body', html.includes(escapeHtml(CURL_EXAMPLE.output)), true);
  check('the captured output really is a 402 challenge', CURL_EXAMPLE.output.includes('"x402Version":2') && CURL_EXAMPLE.output.endsWith('HTTP 402'), true);
  check('no script tag', /<script/i.test(html), false);
  check('no external stylesheet or font', /<link\b|@import|fonts\.googleapis|cdn\./i.test(html), false);
  check('no remote image', /<img\b/i.test(html), false);
  check('styles are inline', html.includes('<style>'), true);
  check('links the source', html.includes(`<a href="${SOURCE}">`), true);
}

// -------------------------------------------- audit off renders as off, honestly
{
  const html = renderPage(describe(cfg(auditOff)));
  check('audit off says so', html.includes('audit trail is off on this instance'), true);
  check('audit off names no topic', html.includes('0.0.10422195'), false);
}

// ------------------------------------------------------------- escaping
{
  const d = describe(cfg({ hcs: true, topic: '<b>x</b>', mirror: 'https://m/"onmouseover="1' }));
  d.what = 'a "quoted" <claim> & more';
  const html = renderPage(d);
  check('descriptor text is escaped', html.includes('a &quot;quoted&quot; &lt;claim&gt; &amp; more'), true);
  check('no raw tag leaks from a value', html.includes('<b>x</b>'), false);
  check('attribute quotes are escaped', html.includes('href="https://m/&quot;onmouseover=&quot;1"'), true);
}

console.log(out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
