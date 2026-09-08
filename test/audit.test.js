// speculum — audit record and vocabulary tests
//
// The pure parts of the Hedera layer: what goes into an HCS message, that it
// fits one chunk, that it survives the trip through base64 the mirror node
// applies, and that the service's words map onto the engine's levels one to
// one. Nothing here touches a network; the live write is bin work, not a test.

import { auditRecord, encodeRecord, decodeRecord, mirrorTxPath, RECORD_LIMIT } from '../hedera/audit.js';
import { outcomeOf, effectsOf } from '../hedera/verdict.js';
import { compare } from '../src/compare.js';
import { hashIntent, hashDeed } from '../src/onchain.js';
import { Level } from '../src/types.js';
import { encodeFunctionData } from 'viem';
import { ABI } from '../src/decode.js';

let pass = 0, fail = 0;
const out = [];
const check = (n, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  out.push(`${ok ? 'ok  ' : 'FAIL'}  ${n}${ok ? '' : `   got ${got}, want ${want}`}`);
};

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
const MAX = (1n << 256n) - 1n;

// ------------------------------------------------------------ vocabulary
check('PASS reads as match', outcomeOf(Level.PASS), 'match');
check('BLOCK reads as divergence', outcomeOf(Level.BLOCK), 'divergence');
check('REFUSE reads as undeterminable', outcomeOf(Level.REFUSE), 'undeterminable');
check('anything else is undeterminable, never match', outcomeOf('UNDETERMINED-ON-HISTORY'), 'undeterminable');

// ------------------------------------------------------------ effects
{
  const intent = { action: 'approve', chainId: 1, token: USDC, amount: 100_000000n, spender: ROUTER };
  const tx = { to: USDC, data: encodeFunctionData({ abi: ABI, functionName: 'approve', args: [ROUTER, MAX] }), value: 0n, chainId: 1 };
  const r = compare(intent, tx);
  const e = effectsOf(r.deed);
  check('effects carry the action', e.action, 'approve');
  check('effects carry the spender', e.spender, ROUTER);
  check('bigints become decimal strings', e.amount, MAX.toString());
  check('flags survive', e.flags.join(','), 'UNBOUNDED_APPROVAL');
  check('JSON serialises without a replacer', typeof JSON.stringify(e), 'string');

  // ---------------------------------------------------------- the record
  const rec = auditRecord({
    intentHash: hashIntent(intent),
    deedHash: hashDeed(tx),
    level: r.level,
    findings: r.findings,
    tier: 'decode',
    paid: { settlement: '0.0.7162784@1788674101.284043818', payer: '0.0.10387590', payTo: '0.0.10386821', amount: '100000', asset: '0.0.0' },
  });
  check('record names the verdict', rec.verdict, 'BLOCK');
  check('and the outcome', rec.outcome, 'divergence');
  check('and the finding codes', rec.findings.join(','), 'UNBOUNDED_APPROVAL,AMOUNT_EXCEEDS_INTENT');
  check('and the settlement it was paid by', rec.paid.settlement, '0.0.7162784@1788674101.284043818');
  check('and the network the settlement is on', rec.network, 'hedera:testnet');

  const wire = encodeRecord(rec);
  check('fits one HCS chunk', Buffer.byteLength(wire, 'utf8') <= RECORD_LIMIT, true);
  const back = decodeRecord(Buffer.from(wire, 'utf8').toString('base64'));
  check('round trips through the mirror node encoding', JSON.stringify(back), JSON.stringify(rec));
  check('a record with no settlement is refused', (() => { try { auditRecord({ ...rec, paid: {} }); return 'built'; } catch (e) { return e.message; } })(), 'a record needs the settlement it was paid by');
}

// ------------------------------------------------- foreign messages on the topic
{
  const foreign = Buffer.from(JSON.stringify({ messageType: 'NeuronHeartBeat', location: { lat: 1 } })).toString('base64');
  check('well-formed JSON that is not a record is refused', (() => { try { decodeRecord(foreign); return 'read'; } catch (e) { return e.message; } })(), 'not a speculum record');
  const junk = Buffer.from('not json at all').toString('base64');
  check('junk is refused too', (() => { try { decodeRecord(junk); return 'read'; } catch (e) { return typeof e.message; } })(), 'string');
}

// ------------------------------------------------------------ settlement id
check('settlement id becomes the mirror path', mirrorTxPath('0.0.7162784@1788674101.284043818'), '0.0.7162784-1788674101-284043818');

console.log(out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
