// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Speculum
/// @notice A public record of what agents said they would do, against what
///         their calldata actually did.
///
/// @dev Nothing is stored. Every check is an event, because the consumer is an
///      indexer, not another contract. Storing would cost the caller ~20k gas
///      per check for data no contract reads. A check that is expensive is a
///      check that gets skipped, and a skipped check protects nobody.
///
///      Deliberately not an executor. Speculum does not hold funds, does not
///      route calls, and cannot be a point of failure in a transaction it
///      judges. It records. Enforcement lives off-chain in the gate and, for
///      anything irreversible, in a hardware confirmation.
contract Speculum {
    /// @dev Mirrors Level in src/types.js. Order is load-bearing.
    uint8 constant PASS = 0;
    uint8 constant BLOCK = 1;
    uint8 constant REFUSE = 2;

    /// @notice A transaction was checked against a declared intent.
    /// @param agent      the address that will sign, if it proceeds
    /// @param intentHash keccak of the canonical declared intent
    /// @param deedHash   keccak of chainId, to, value and calldata
    /// @param level      0 pass, 1 block, 2 refuse
    /// @param findings   bitfield of divergence classes, see FINDING_BITS
    /// @param target     the contract the calldata calls
    event Checked(
        address indexed agent,
        bytes32 indexed intentHash,
        bytes32 indexed deedHash,
        uint8 level,
        uint32 findings,
        address target
    );

    /// @notice A human overrode a block. This is the accountability half.
    /// @dev Emitted after a hardware confirmation. An override with no prior
    ///      Checked event for the same deedHash is itself a finding, and the
    ///      subgraph surfaces those: it means something bypassed the gate.
    event Overridden(bytes32 indexed deedHash, address indexed approver);

    /// @notice The agent declared an intent before producing calldata.
    /// @dev Emitting this first is what makes the ordering provable. An intent
    ///      published only after the calldata exists proves nothing, because it
    ///      could have been written to fit.
    event Declared(address indexed agent, bytes32 indexed intentHash, uint64 nonce);

    mapping(address => uint64) public nonces;

    function declare(bytes32 intentHash) external returns (uint64 nonce) {
        nonce = ++nonces[msg.sender];
        emit Declared(msg.sender, intentHash, nonce);
    }

    function record(
        bytes32 intentHash,
        bytes32 deedHash,
        uint8 level,
        uint32 findings,
        address target
    ) external {
        require(level <= REFUSE, "bad level");
        // A clean verdict carrying findings, or a flagged verdict carrying
        // none, would corrupt every downstream count. Reject rather than index
        // a contradiction.
        require((level == PASS) == (findings == 0), "level contradicts findings");
        emit Checked(msg.sender, intentHash, deedHash, level, findings, target);
    }

    function override_(bytes32 deedHash) external {
        emit Overridden(deedHash, msg.sender);
    }
}
