# speculum on Hedera

Sells the gate by the call. An agent posts what it says it is about to do and
the calldata it is about to sign, pays in HBAR, and gets a verdict back. No
account, no API key, no subscription.

## Why metered rather than flat

A decode-only check is pure computation. A check with simulation costs an RPC
round trip against live chain state. One flat price would either overcharge the
cheap call or subsidise the expensive one, so the service quotes two tiers and
charges for the tier actually requested.

| tier | tinybar | HBAR | covers |
|---|---|---|---|
| decode | 100,000 | 0.001 | decode the calldata and compare it against the declaration |
| simulated | 500,000 | 0.005 | adds a balance-delta simulation against live state |

## Flow

1. `GET /` returns a service descriptor: what it does, what it costs, which
   network and facilitator settle the payment.
2. `POST /check` with no payment returns **402** with the payment requirements,
   including the facilitator's current fee payer.
3. The agent signs a payment for exactly what was quoted and retries with an
   `X-PAYMENT` header.
4. The service asks the facilitator to verify, then settle, and only then does
   the work. The verdict returns with the settlement transaction.

The fee payer is read from `/supported` on every quote rather than cached. A
stale fee payer produces a payload that signs fine locally and fails at
settlement, which would leave the agent thinking it had paid.

## The price is the server's, not the client's

The client sends what it agreed to pay inside the payment payload. The service
verifies against **its own** requirements rather than the ones in that payload,
so a client cannot name its own price. That is the same rule the rest of the
project runs on: never accept the caller's description of what it is doing as
the thing being checked.

## Failure after settlement is reported, not hidden

If the payment settles and the check then throws, the response says the work
failed and includes the settlement transaction. Returning a verdict nobody
computed, or a silent error after taking payment, would both be worse than an
honest failure.

## What is verified

- `@x402/hedera` 2.25.0 installed, exports read off the package rather than the
  docs: `ExactHederaScheme` from `exact/client` and `exact/server`,
  `createClientHederaSigner`, `PrivateKey`.
- Facilitator live at `https://api.testnet.blocky402.com`, advertising
  `hedera:testnet` with fee payer `0.0.7162784`, read from its `/supported`.
- Constants taken from the SDK, not hardcoded: `HBAR_ASSET_ID` is `0.0.0`,
  `HEDERA_TESTNET_CAIP2` is `hedera:testnet`.
- The service boots, serves the descriptor, and gates `/check`.

**A real payment has settled.** Hedera testnet, through the hosted Blocky402
facilitator:

- 100,000 tinybar (0.001 HBAR), `0.0.10387590` to `0.0.10386821`
- settlement `0.0.7162784@1788674101.284043818`
- the agent declared it was sending 100 USDC to itself; the calldata sent it
  elsewhere; the verdict was `BLOCK` on `RECIPIENT_MISMATCH`

The agent paid to be told no about its own transaction.

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

## Run it

Service:

```
HEDERA_ACCOUNT_ID=0.0.<service> npm run serve
```

Agent, in another shell:

```
HEDERA_ACCOUNT_ID=0.0.<agent> HEDERA_PRIVATE_KEY=0x<ecdsa> npm run agent
```
