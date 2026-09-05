// speculum — simulation
//
// Decoding tells you what a call SAYS it does. Simulation tells you what it
// actually does to balances. The two are different questions and a transaction
// can pass the first and fail the second: a fee-on-transfer token delivers less
// than the argument claims, a router can move funds through paths the top-level
// call never names, and a proxy can do something entirely unrelated to its ABI.
//
// The RPC is injected rather than constructed here. That keeps this file pure
// and testable without a network, and it means a caller can point speculum at
// any node, a fork, or a local anvil without touching the engine.

import { encodeFunctionData, decodeAbiParameters, parseAbi, getAddress } from 'viem';
import { Finding, Level } from './types.js';

const BALANCE_OF = parseAbi(['function balanceOf(address owner) view returns (uint256)']);

/** Findings that only simulation can produce. */
export const SimFinding = Object.freeze({
  BALANCE_DELTA_MISMATCH: 'BALANCE_DELTA_MISMATCH',
  RECIPIENT_RECEIVED_NOTHING: 'RECIPIENT_RECEIVED_NOTHING',
  UNDECLARED_ASSET_MOVED: 'UNDECLARED_ASSET_MOVED',
  SIMULATION_REVERTED: 'SIMULATION_REVERTED',
  SIMULATION_UNAVAILABLE: 'SIMULATION_UNAVAILABLE',
});

export const SIM_LEVEL = Object.freeze({
  [SimFinding.BALANCE_DELTA_MISMATCH]: Level.BLOCK,
  [SimFinding.RECIPIENT_RECEIVED_NOTHING]: Level.BLOCK,
  [SimFinding.UNDECLARED_ASSET_MOVED]: Level.BLOCK,
  [SimFinding.SIMULATION_REVERTED]: Level.BLOCK,
  // Cannot determine is never a pass. If the node is down, speculum says so
  // rather than quietly downgrading to the weaker decode-only check.
  [SimFinding.SIMULATION_UNAVAILABLE]: Level.REFUSE,
});

export const SIM_TEXT = Object.freeze({
  [SimFinding.BALANCE_DELTA_MISMATCH]:
    'the amount that actually leaves the sender differs from the amount declared',
  [SimFinding.RECIPIENT_RECEIVED_NOTHING]:
    'the declared recipient receives nothing when this transaction runs',
  [SimFinding.UNDECLARED_ASSET_MOVED]:
    'a token that was never declared moves out of the sender',
  [SimFinding.SIMULATION_REVERTED]:
    'the transaction reverts when run against current chain state',
  [SimFinding.SIMULATION_UNAVAILABLE]:
    'the effect could not be simulated, so it is unknown',
});

/**
 * @typedef {Object} Rpc
 * @property {(calls: object[]) => Promise<object>} simulate
 *   Runs a batch against a pending block with state overrides and returns
 *   per-call results. Maps onto eth_simulateV1.
 */

/**
 * Read a set of token balances for one address, before and after a call.
 *
 * Implemented with eth_simulateV1 so the reads happen in the same simulated
 * block as the transaction. Reading balances with separate eth_call requests
 * would sample a different state and produce deltas that never existed.
 */
export async function simulateDeltas(rpc, { tx, from, tokens }) {
  const probes = tokens.map((t) => ({
    to: t,
    data: encodeFunctionData({ abi: BALANCE_OF, functionName: 'balanceOf', args: [from] }),
  }));

  const block = {
    calls: [
      ...probes,
      { from, to: tx.to, data: tx.data ?? '0x', value: `0x${BigInt(tx.value ?? 0).toString(16)}` },
      ...probes,
    ],
  };

  const res = await rpc.simulate([block]);
  const calls = res?.[0]?.calls;
  if (!Array.isArray(calls) || calls.length !== probes.length * 2 + 1) {
    throw new Error('simulation returned an unexpected shape');
  }

  const txResult = calls[probes.length];
  if (txResult.status === '0x0' || txResult.status === 0) {
    return { reverted: true, revertReason: txResult.error?.message ?? null, deltas: null };
  }

  const readU256 = (c) => {
    if (!c.returnData || c.returnData === '0x') return null;
    try {
      return decodeAbiParameters([{ type: 'uint256' }], c.returnData)[0];
    } catch {
      return null;
    }
  };

  const deltas = {};
  for (let i = 0; i < tokens.length; i++) {
    const before = readU256(calls[i]);
    const after = readU256(calls[probes.length + 1 + i]);
    // A balance that could not be read is not a delta of zero. Recording it as
    // zero would turn a failed read into evidence that nothing moved, which is
    // exactly the class of lie this project exists to catch.
    deltas[getAddress(tokens[i])] = before == null || after == null ? null : after - before;
  }

  return { reverted: false, revertReason: null, deltas };
}

/**
 * Compare a declared intent against simulated balance movement.
 *
 * @param {object}  intent
 * @param {object}  tx
 * @param {Rpc}     rpc
 * @param {object}  opts
 * @param {string}  opts.from      the signer
 * @param {string[]} [opts.watch]  extra tokens to watch beyond the declared one
 * @param {number}  [opts.amountTolerance]
 */
export async function verifyEffect(intent, tx, rpc, opts) {
  const from = opts.from;
  const tolerance = opts.amountTolerance ?? 0;
  const findings = [];
  const add = (code, detail) =>
    findings.push({ code, level: SIM_LEVEL[code], why: SIM_TEXT[code], detail });

  const watch = [...new Set([
    ...(intent.token && intent.token !== 'native' ? [intent.token] : []),
    ...(opts.watch ?? []),
  ].map((a) => getAddress(a)))];

  let sim;
  try {
    sim = await simulateDeltas(rpc, { tx, from, tokens: watch });
  } catch (err) {
    add(SimFinding.SIMULATION_UNAVAILABLE, String(err.message ?? err));
    return { level: Level.REFUSE, findings, deltas: null };
  }

  if (sim.reverted) {
    add(SimFinding.SIMULATION_REVERTED, sim.revertReason);
    return { level: Level.BLOCK, findings, deltas: null };
  }

  const declaredToken = intent.token && intent.token !== 'native' ? getAddress(intent.token) : null;
  const declared = intent.amount != null ? BigInt(intent.amount) : null;

  for (const [token, delta] of Object.entries(sim.deltas)) {
    if (delta === null) {
      add(SimFinding.SIMULATION_UNAVAILABLE, `balance of ${token} could not be read`);
      continue;
    }
    if (delta >= 0n) continue; // nothing left the sender for this token

    const out = -delta;

    if (declaredToken && token === declaredToken) {
      if (declared != null) {
        const ceiling = declared + (declared * BigInt(Math.round(tolerance * 10_000))) / 10_000n;
        if (out > ceiling) {
          add(SimFinding.BALANCE_DELTA_MISMATCH, `declared ${declared}, ${out} actually leaves`);
        }
      }
    } else {
      add(SimFinding.UNDECLARED_ASSET_MOVED, `${out} of ${token} leaves the sender`);
    }
  }

  // A refusal anywhere outranks a block, same rule as the decode path.
  const level = findings.some((f) => f.level === Level.REFUSE)
    ? Level.REFUSE
    : findings.length
      ? Level.BLOCK
      : Level.PASS;

  return { level, findings, deltas: sim.deltas };
}

/** Minimal eth_simulateV1 transport over any JSON-RPC endpoint. */
export function jsonRpc(url, fetchImpl = fetch) {
  let id = 0;
  return {
    async simulate(blocks) {
      const r = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++id,
          method: 'eth_simulateV1',
          params: [{ blockStateCalls: blocks, validation: false, traceTransfers: true }, 'latest'],
        }),
      });
      const j = await r.json();
      if (j.error) throw new Error(`rpc: ${j.error.message}`);
      return j.result;
    },
  };
}
