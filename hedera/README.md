# speculum on Hedera

Sells the gate by the call. An agent posts what it says it is about to do and
the calldata it is about to sign, pays in HBAR, and gets a verdict back. No
account, no API key, no subscription. Every paid verdict is written to Hedera
Consensus Service with the settlement that paid for it, so the trail can be
checked by someone who was not there.

**Network: Hedera testnet.** Settlement through the hosted Blocky402
facilitator at `https://api.testnet.blocky402.com`. Blocky402 also hosts a
mainnet facilitator at `https://api.blocky402.com` (`hedera:mainnet`, fee payer
`0.0.10571514`, read from its `/supported` on Sep 8 2026); this service is not
pointed at it.

**Live endpoint:** `https://speculum.ochinimus.app`
**Audit topic:** `0.0.10422195` on Hedera testnet, publicly readable.

| | |
|---|---|
| `GET /` | service descriptor: what it does, what it costs, network, facilitator, audit topic |
| `GET /health` | liveness, plus whether the audit trail is on |
| `POST /check` | the gate. 402 without payment, the verdict with it |

## Price per call

Metered rather than flat. A decode-only check is pure computation. A check
with simulation costs an RPC round trip against live chain state. One flat
price would either overcharge the cheap call or subsidise the expensive one,
so the service quotes two tiers and charges for the tier actually requested.

| tier | tinybar | HBAR | covers |
|---|---|---|---|
| decode | 100,000 | 0.001 | decode the calldata and compare it against the declaration |
| simulated | 500,000 | 0.005 | adds a balance-delta simulation against live state (needs `RPC_URL` on the service and `simulate: true, from` in the request) |

Asset is native HBAR, `0.0.0` in the x402 requirements. HTS tokens are
accepted by the facilitator (asset = token id) and not used here.

## Architecture

```
agent                      speculum service                 Blocky402            Hedera
  |  POST /check {intent,tx}      |                              |                  |
  |------------------------------>|  GET /supported (fee payer)  |                  |
  |                               |----------------------------->|                  |
  |  402 {accepts:[requirements]} |                              |                  |
  |<------------------------------|                              |                  |
  |  sign TransferTransaction     |                              |                  |
  |  POST /check + X-PAYMENT      |                              |                  |
  |------------------------------>|  POST /verify                |                  |
  |                               |----------------------------->|                  |
  |                               |  POST /settle                |  co-sign, submit |
  |                               |----------------------------->|----------------->|
  |                               |  {success, transaction}      |                  |
  |                               |  gate.check(intent, tx)      |                  |
  |                               |  TopicMessageSubmit(record)  |     HCS topic    |
  |                               |------------------------------------------------>|
  |  200 {verdict, outcome,       |                              |                  |
  |       effects, paid, audit}   |                              |                  |
  |<------------------------------|                              |                  |
```

Files:

- `server.js` — the gated service. Quotes, verifies, settles, then runs the
  existing engine (`src/gate.js` → `src/compare.js` → `src/decode.js`)
  untouched. Holds no payment key.
- `agent.js` — the consumer. Discovers, gets a 402, pays, retries, acts.
- `verdict.js` — the vocabulary: PASS/BLOCK/REFUSE ↔ match/divergence/undeterminable, and the derived effects as plain JSON.
- `audit.js` — the HCS record, the writer, and the mirror-node reader.
- `topic.js` — creates the audit topic once.
- `audit-verify.js` — checks a topic against the mirror node, no key.
- `run.sh` — one command: service, agent, both keys at prompts.
- `probe-key.js` — which parse of a key actually controls an account.
- `BRIEF.md` — the brief this was built against, verbatim.

## The payment flow, as the wire carries it

1. `POST /check` with `{ intent, tx }` and no payment. The service reads the
   facilitator's `/supported` for the current Hedera fee payer, and answers
   **402** with `{ x402Version: 2, accepts: [requirements] }` where
   requirements is `{ scheme: 'exact', network: 'hedera:testnet', amount,
   payTo, maxTimeoutSeconds: 300, asset: '0.0.0', extra: { feePayer } }`.
   The fee payer is read on every quote, never cached; a stale one produces a
   payload that signs locally and fails at settlement, leaving the agent
   thinking it paid.
2. The agent builds a partially signed `TransferTransaction` for exactly the
   quoted amount with `@x402/hedera`'s `ExactHederaScheme`, wraps it as
   `{ x402Version: 2, scheme, network, accepted: requirements, payload: { transaction } }`,
   and retries with that JSON base64 in the `X-PAYMENT` header.
3. The service posts `{ x402Version: 2, paymentPayload, paymentRequirements }`
   to the facilitator's `/verify`, then `/settle`. `paymentRequirements` is
   **the service's own quote**, not the `accepted` block the client sent, so a
   client cannot name its own price. That is the same rule the rest of the
   project runs on: never accept the caller's description of what it is
   doing as the thing being checked.
4. `/settle` returns `{ success, transaction, network, payer }`. The
   `transaction` is the settlement reference, in the form
   `0.0.<feePayer>@<seconds>.<nanos>`, and the mirror node holds it at
   `/api/v1/transactions/0.0.<feePayer>-<seconds>-<nanos>`.
5. Only then does the engine run. The response carries `verdict`
   (`PASS`/`BLOCK`/`REFUSE`), `outcome` (`match`/`divergence`/`undeterminable`),
   `divergence` (the finding codes when blocked), `findings`, `effects` (the
   deed the decoder derived: action, token, amount, recipient, spender,
   value, and the legs of a batch), `intentHash`, `deedHash`, `paid`, and
   `audit`.

If the payment settles and the check then throws, the response says the work
failed and includes the settlement. Returning a verdict nobody computed, or a
silent error after taking payment, would both be worse than an honest failure.

## Audit trail on HCS

After the verdict and before the response, the service submits one message to
its topic:

```
{ v: 1, service: 'speculum', network: 'hedera:testnet',
  intentHash, deedHash, verdict, outcome, findings: [codes], tier,
  paid: { settlement, payer, payTo, amount, asset } }
```

Hashes rather than the intent and bytes themselves, since the bytes may be
private and a hash is enough to prove a later claim was the same claim. One
chunk, so the mirror node shows one message per verdict. The response's
`audit` block carries the topic, the sequence number the network assigned,
the submit transaction, and the mirror-node URL of that exact message. If the
write fails the verdict still returns, and `audit.error` says so rather than
pretending.

Anyone can check the trail with no key and no account:

```
node hedera/audit-verify.js 0.0.<topic>
```

It reads the topic from the public mirror node, decodes every record, fetches
the settlement each one claims, and checks that the ledger agrees: the
transaction exists, succeeded, and moved the recorded amount from the recorded
payer to the recorded payee. A record that does not hold up fails the run.

The trail is on only when the service has `HEDERA_OPERATOR_ID`,
`HEDERA_OPERATOR_KEY` (an ECDSA key for a funded account, it pays the HCS fee)
and `HEDERA_TOPIC_ID`. With any of them missing it runs with the trail off and
says so in `GET /` and `GET /health` as `audit.hcs: false`. A half configured
trail that silently skipped writes would be a record that lies by omission.

## Setup

Service, locally:

```
HEDERA_ACCOUNT_ID=0.0.<service> npm run serve
```

With the audit trail (create the topic once, keep the id):

```
HEDERA_OPERATOR_ID=0.0.<operator> HEDERA_OPERATOR_KEY=0x<ecdsa> npm run topic
HEDERA_ACCOUNT_ID=0.0.<service> HEDERA_OPERATOR_ID=0.0.<operator> HEDERA_OPERATOR_KEY=0x<ecdsa> HEDERA_TOPIC_ID=0.0.<topic> npm run serve
```

Agent, against any service:

```
SERVICE=https://speculum.ochinimus.app HEDERA_ACCOUNT_ID=0.0.<agent> HEDERA_PRIVATE_KEY=0x<ecdsa> npm run agent
```

`CASE=honest`, `CASE=divergent` or the default `both`. Or everything at once
with keys read at prompts, never as arguments: `./hedera/run.sh`.

Hosted, on the box behind `speculum.ochinimus.app`: `/opt/speculum` is a clone
of this repository, `npm ci --omit=dev --ignore-scripts`, PM2 process
`speculum` on port 3027 started with `--node-args="--env-file=/opt/speculum/.env"`
so the env file is read at every start. The three audit variables are in
that file and the trail is on.

## What is verified

- `@x402/hedera` 2.25.0 installed, exports read off the package rather than the
  docs: `ExactHederaScheme` from `exact/client` and `exact/server`,
  `createClientHederaSigner`, `PrivateKey`. It carries `@hiero-ledger/sdk`
  2.85.0, now pinned as a direct dependency for the HCS classes.
- Facilitator live at `https://api.testnet.blocky402.com`, advertising
  `hedera:testnet` with fee payer `0.0.7162784`, read from its `/supported`
  on Sep 8 2026. Its docs (`blocky402.com/docs`) match what is built:
  `/supported`, `/verify`, `/settle`, x402 v2, HBAR as `0.0.0`, amounts in
  tinybar, `extra.feePayer` required, settlement id `0.0.<feePayer>@<s>.<n>`.
- Constants taken from the SDK, not hardcoded: `HBAR_ASSET_ID` is `0.0.0`,
  `HEDERA_TESTNET_CAIP2` is `hedera:testnet`.
- The service boots, serves the descriptor, and gates `/check`. A garbage
  `X-PAYMENT` gets 400. A forged payload reaches the facilitator and comes
  back `invalid_exact_hedera_payload_transaction_could_not_be_decoded`, 402,
  no settlement, no verdict.
- The hosted endpoint answers from outside. On Sep 8 2026, from a laptop in
  Chisinau: `GET /health` 200 in 165 ms at the Cloudflare edge and 108 ms
  from the box itself; unpaid `POST /check` 402 with the full challenge in
  124, 129 and 241 ms across three tries. The neighbouring hostnames on the
  same tunnel still answered 200 after the ingress reload.
- The mirror-node reader and the verifier were run against a foreign testnet
  topic (`0.0.5915425`, someone else's heartbeat feed): the messages are
  decoded, recognised as not speculum records, and the run fails as it
  should. The settlement reader was run against the real settlement below and
  the mirror node returned `CRYPTOTRANSFER SUCCESS` with the two transfers.

**A real payment has settled.** Hedera testnet, through the hosted Blocky402
facilitator, re-read from the mirror node on Sep 8 2026:

- 100,000 tinybar (0.001 HBAR), agent `0.0.10387590` to service `0.0.10386821`
- settlement `0.0.7162784@1788674101.284043818`, consensus `1788674105.877638999`,
  facilitator fee 243,481 tinybar paid by the fee payer
- the agent declared it was sending 100 USDC to itself; the calldata sent it
  elsewhere; the verdict was `BLOCK` on `RECIPIENT_MISMATCH`

The agent paid to be told no about its own transaction.

## What was observed

The divergence run completed against `https://speculum.ochinimus.app` on
Sep 8 2026 with the audit trail on. Every figure below was read back off the
public testnet mirror node, not off the agent's own output.

Audit topic `0.0.10422195`, memo `speculum verdicts`, auto-renew account
`0.0.10386821`, created at consensus `1788873576.556111066`. It has no submit
key, so anyone can read it while only the service's operator writes to it.

The agent, account `0.0.10422368`, bought two decode-tier checks at 100,000
tinybar (0.001 HBAR) each, paid to `0.0.10386821`. Both payments settled
through the Blocky402 facilitator, whose fee payer `0.0.7162784` carried the
network fee of 250,094 tinybar on each.

| the agent said / the bytes did | verdict | settlement | ledger | HCS |
|---|---|---|---|---|
| approve exactly 100 USDC / approve exactly 100 USDC | `PASS`, match, no findings | `0.0.7162784@1788874527.034251033` | `CRYPTOTRANSFER SUCCESS` at `1788874534.791406183` | `#1` at `1788874536.219819514` |
| approve exactly 100 USDC / approve unlimited USDC | `BLOCK`, divergence, `UNBOUNDED_APPROVAL`, `AMOUNT_EXCEEDS_INTENT` | `0.0.7162784@1788874531.474869153` | `CRYPTOTRANSFER SUCCESS` at `1788874538.516692055` | `#2` at `1788874539.641386391` |

The agent proceeded on the first and refused to sign the second.

Both records carry the **same** `intentHash`:

```
0xba1f1e935187296d288ae25e4704ce9a714e9b16c210a581c58d43f3c0cce1ec
```

and **different** `deedHash` values, `0x26ac208bf6a45aabfc45e20ccc33c14e3d91cb4b6b04bde3cb42c5e7434eb1dd`
for the exact approval and `0x52be96a810e035a4933d896ac39cce25278c8681a9600800a6943ff93632c850`
for the unlimited one. That is the project's thesis in two rows on a public
ledger: the declaration was identical, the bytes were not, and only the
comparison could tell them apart.

Anyone can read the trail, with no key and no account:

```
node hedera/audit-verify.js 0.0.10422195
```

On Sep 8 2026 that fetched both records, fetched both settlements from the
ledger, and printed `2 record(s), 2 hold, 0 do not`. Or straight from the
mirror node, where each `message` is the base64 of the JSON record:

```
curl https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10422195/messages
```

The hosted service answers `audit.hcs: true` with that topic on `GET /health`.

### What the first attempt taught

Settlement failed once with `INVALID_SIGNATURE`. Rather than guess at
encodings, a probe derived the public key from the private key under every
parse the SDK offers and compared each against what the mirror node said the
account actually held.

The finding is worth keeping: **the same hex string parses successfully under
`fromStringECDSA`, `fromStringED25519` and `fromStringDer`, and produces a
different key under each.** Only one throws no error and is still wrong. The
probe showed no parse matched that account at all, which meant the key and the
account id had come from different rows of the portal — a swap no encoding
change could have fixed.

`hedera/probe-key.js` is kept for that reason. It prints public keys only.
