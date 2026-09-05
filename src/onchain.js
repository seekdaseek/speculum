// speculum — on-chain encoding
//
// The contract emits findings as a bitfield, so the JS side and the subgraph
// must agree on bit order exactly. This file is the single definition of that
// order. Appending is safe; reordering or removing is not, because it would
// silently reinterpret every event already indexed.

import { keccak256, toHex, encodeAbiParameters } from 'viem';
import { Finding, Level } from './types.js';

/** Bit position per finding. APPEND ONLY. Never reorder, never reuse. */
export const FINDING_BITS = Object.freeze({
  [Finding.ACTION_MISMATCH]: 0,
  [Finding.TOKEN_MISMATCH]: 1,
  [Finding.RECIPIENT_MISMATCH]: 2,
  [Finding.SPENDER_MISMATCH]: 3,
  [Finding.AMOUNT_EXCEEDS_INTENT]: 4,
  [Finding.CHAIN_MISMATCH]: 5,
  [Finding.NATIVE_VALUE_UNDECLARED]: 6,
  [Finding.UNBOUNDED_APPROVAL]: 7,
  [Finding.APPROVAL_FOR_ALL]: 8,
  [Finding.OWNERSHIP_TRANSFER]: 9,
  [Finding.PROXY_UPGRADE]: 10,
  [Finding.SELF_DESTRUCT]: 11,
  [Finding.UNKNOWN_SELECTOR]: 12,
  [Finding.MALFORMED_CALLDATA]: 13,
  [Finding.ARGUMENTS_UNDECODABLE]: 14,
});

export const LEVEL_CODE = Object.freeze({ [Level.PASS]: 0, [Level.BLOCK]: 1, [Level.REFUSE]: 2 });

export function encodeFindings(findings) {
  let bits = 0;
  for (const f of findings) {
    const bit = FINDING_BITS[f.code ?? f];
    if (bit === undefined) throw new Error(`no bit assigned for finding ${f.code ?? f}`);
    bits |= 1 << bit;
  }
  return bits >>> 0;
}

export function decodeFindings(bits) {
  return Object.entries(FINDING_BITS)
    .filter(([, bit]) => (bits >>> bit) & 1)
    .map(([code]) => code);
}

/**
 * Canonical hash of a declared intent.
 *
 * Fields are hashed in a fixed order with fixed types so the same intent always
 * produces the same hash regardless of key order in the object. Absent fields
 * hash as zero rather than being skipped, otherwise omitting a field would
 * produce a different shape rather than a different value, and two different
 * intents could collide.
 */
export function hashIntent(intent) {
  const zeroAddr = '0x0000000000000000000000000000000000000000';
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'string' }, { type: 'uint256' }, { type: 'address' },
        { type: 'address' }, { type: 'address' }, { type: 'uint256' },
        { type: 'uint256' }, { type: 'bool' },
      ],
      [
        intent.action ?? '',
        BigInt(intent.chainId ?? 0),
        intent.token && intent.token !== 'native' ? intent.token : zeroAddr,
        intent.recipient ?? zeroAddr,
        intent.spender ?? zeroAddr,
        BigInt(intent.amount ?? 0),
        BigInt(intent.value ?? 0),
        intent.unlimited === true,
      ],
    ),
  );
}

/** Canonical hash of the transaction actually being signed. */
export function hashDeed(tx) {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes' }],
      [BigInt(tx.chainId), tx.to, BigInt(tx.value ?? 0), tx.data ?? '0x'],
    ),
  );
}

export { toHex };
