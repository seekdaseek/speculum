// speculum — decoder
//
// Turns a raw transaction into a Deed: a plain statement of what the bytes do.
// It never sees the Intent. That separation is the whole point of the check.

import { decodeFunctionData, parseAbi, getAddress, toFunctionSelector } from 'viem';
import { Action, Finding } from './types.js';

const MAX_UINT256 = (1n << 256n) - 1n;

// Some routers treat anything above a threshold as "infinite" in practice.
// A 2^255 approval is not literally max uint256 but is unbounded for any real
// token supply, so it is treated the same.
const UNBOUNDED_FLOOR = 1n << 200n;

export const ABI = parseAbi([
  'function transfer(address to, uint256 amount)',
  'function transferFrom(address from, address to, uint256 amount)',
  'function approve(address spender, uint256 amount)',
  'function increaseAllowance(address spender, uint256 addedValue)',
  'function setApprovalForAll(address operator, bool approved)',
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
  'function deposit(uint256 assets, address receiver)',
  'function withdraw(uint256 assets, address receiver, address owner)',
  'function transferOwnership(address newOwner)',
  'function upgradeTo(address newImplementation)',
  'function upgradeToAndCall(address newImplementation, bytes data)',
  // Uniswap V3 SwapRouter
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params)',
  // Uniswap universal-style multicall wrapper
  'function multicall(uint256 deadline, bytes[] data)',
]);

/** Every 4-byte selector speculum can decode. Anything outside this set is
 *  unknown, and unknown means refuse rather than guess. */
export const KNOWN_SELECTORS = new Set(
  ABI.filter((e) => e.type === 'function').map((e) => toFunctionSelector(e).toLowerCase()),
);

/**
 * @typedef {Object} Deed
 * @property {string}  [action]     one of Action, when determinable
 * @property {string}  [asset]      token contract whose balance leaves the sender
 * @property {string}  [toAsset]    token received, for swaps
 * @property {bigint}  [amount]     amount leaving the sender
 * @property {bigint}  [minOut]     minimum received, for swaps
 * @property {string}  [recipient]  where value lands
 * @property {string}  [spender]    who is granted allowance
 * @property {bigint}  value        native currency attached
 * @property {number}  chainId
 * @property {string}  target       the contract being called
 * @property {string}  [selector]
 * @property {string[]} flags       findings the bytes raise on their own
 */

const norm = (a) => {
  try { return getAddress(a); } catch { return String(a).toLowerCase(); }
};

/**
 * Derive a Deed from a transaction. Pure: no network, no intent.
 * @param {{to:string, data?:string, value?:bigint|string|number, chainId:number}} tx
 * @returns {Deed}
 */
export function decode(tx) {
  const deed = {
    value: BigInt(tx.value ?? 0),
    chainId: tx.chainId,
    target: norm(tx.to),
    flags: [],
  };

  const data = tx.data ?? '0x';

  // A bare value send with no calldata is a native transfer. Fully determined.
  if (data === '0x' || data === '') {
    deed.action = Action.TRANSFER;
    deed.asset = 'native';
    deed.amount = deed.value;
    deed.recipient = deed.target;
    return deed;
  }

  if (typeof data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(data) || data.length < 10) {
    deed.flags.push(Finding.MALFORMED_CALLDATA);
    return deed;
  }

  deed.selector = data.slice(0, 10).toLowerCase();

  let fn, args;
  try {
    ({ functionName: fn, args } = decodeFunctionData({ abi: ABI, data }));
  } catch {
    // Two different failures land here and they are not the same thing.
    // An unrecognised selector means the function is unknown outright.
    // A known selector with unreadable arguments means the function is known
    // but its parameters cannot be trusted. Both refuse, but an operator
    // reading the log needs to know which one happened.
    deed.flags.push(
      KNOWN_SELECTORS.has(deed.selector)
        ? Finding.ARGUMENTS_UNDECODABLE
        : Finding.UNKNOWN_SELECTOR,
    );
    return deed;
  }

  switch (fn) {
    case 'transfer':
      deed.action = Action.TRANSFER;
      deed.asset = deed.target;
      deed.recipient = norm(args[0]);
      deed.amount = args[1];
      break;

    case 'transferFrom':
      deed.action = Action.TRANSFER;
      deed.asset = deed.target;
      deed.recipient = norm(args[1]);
      deed.amount = args[2];
      break;

    case 'approve':
    case 'increaseAllowance':
      deed.action = Action.APPROVE;
      deed.asset = deed.target;
      deed.spender = norm(args[0]);
      deed.amount = args[1];
      if (deed.amount >= UNBOUNDED_FLOOR) deed.flags.push(Finding.UNBOUNDED_APPROVAL);
      break;

    case 'setApprovalForAll':
      deed.action = Action.APPROVE;
      deed.asset = deed.target;
      deed.spender = norm(args[0]);
      if (args[1] === true) deed.flags.push(Finding.APPROVAL_FOR_ALL);
      break;

    case 'safeTransferFrom':
      deed.action = Action.TRANSFER;
      deed.asset = deed.target;
      deed.recipient = norm(args[1]);
      deed.amount = 1n;
      break;

    case 'exactInputSingle': {
      const p = args[0];
      deed.action = Action.SWAP;
      deed.asset = norm(p.tokenIn);
      deed.toAsset = norm(p.tokenOut);
      deed.amount = p.amountIn;
      deed.minOut = p.amountOutMinimum;
      deed.recipient = norm(p.recipient);
      break;
    }

    case 'deposit':
      deed.action = Action.DEPOSIT;
      deed.asset = deed.target;
      deed.amount = args[0];
      deed.recipient = norm(args[1]);
      break;

    case 'withdraw':
      deed.action = Action.WITHDRAW;
      deed.asset = deed.target;
      deed.amount = args[0];
      deed.recipient = norm(args[1]);
      break;

    case 'transferOwnership':
      deed.flags.push(Finding.OWNERSHIP_TRANSFER);
      deed.recipient = norm(args[0]);
      break;

    case 'upgradeTo':
    case 'upgradeToAndCall':
      deed.flags.push(Finding.PROXY_UPGRADE);
      break;

    case 'multicall':
      // A batch is only as knowable as its least knowable leg. Rather than
      // pretend otherwise, refuse and say why. Recursing into each leg is the
      // right long-term answer; claiming to have done it would be a lie.
      deed.flags.push(Finding.ARGUMENTS_UNDECODABLE);
      break;

    default:
      deed.flags.push(Finding.UNKNOWN_SELECTOR);
  }

  return deed;
}

export { MAX_UINT256, UNBOUNDED_FLOOR };
