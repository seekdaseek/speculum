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

    /// @notice A human overrode a block, and proved it.
    /// @dev The first version of this event carried only msg.sender, so an
    ///      override asserted that a human approved and committed to nothing.
    ///      The project's own rule is that a confirmation which does not
    ///      commit to specific bytes is worse than none, and the record broke
    ///      it: eight overrides on chain that block gaps could not tell from a
    ///      script. Now the approver signs the approval message on the device,
    ///      the message names the deed hash, and the contract recovers the
    ///      signer before it will emit anything. An override that does not
    ///      recover is rejected, not recorded as unproven.
    /// @param deedHash  the bytes the human saw and approved
    /// @param approver  the address recovered from the device signature
    /// @param submitter the address that relayed the override, usually the agent
    /// @param level     the verdict the human was shown, 1 block or 2 refuse
    /// @param reason    the one-line reason the human was shown
    /// @param signature 65-byte EIP-191 signature over approvalMessage()
    event Overridden(
        bytes32 indexed deedHash,
        address indexed approver,
        address submitter,
        uint8 level,
        string reason,
        bytes signature
    );

    /// @notice The agent declared an intent before producing calldata.
    /// @dev Emitting this first is what makes the ordering provable. An intent
    ///      published only after the calldata exists proves nothing, because it
    ///      could have been written to fit.
    event Declared(address indexed agent, bytes32 indexed intentHash, uint64 nonce);

    mapping(address => uint64) public nonces;

    /// @dev Named declareIntent rather than declare because `declare` is a
    ///      reserved word in AssemblyScript, and The Graph's codegen emits a
    ///      binding method per external function. A contract function called
    ///      `declare` makes it impossible to compile a subgraph against this
    ///      ABI at all. Found by building the subgraph, not by reading docs.
    function declareIntent(bytes32 intentHash) external returns (uint64 nonce) {
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

    /// @dev Likewise not named `override`, which is reserved in both Solidity
    ///      and AssemblyScript.
    ///
    ///      The message is rebuilt here from its parts rather than passed in,
    ///      so the signature can only ever be over a message that names this
    ///      deed hash. A caller who could supply the message text could supply
    ///      one naming different bytes, which is the failure the gate's
    ///      approval binding exists to prevent.
    function recordOverride(
        bytes32 deedHash,
        uint8 level,
        string calldata reason,
        bytes calldata signature
    ) external {
        require(level == BLOCK || level == REFUSE, "nothing to override");
        address approver = recoverApprover(deedHash, level, reason, signature);
        require(approver != address(0), "signature does not recover");
        emit Overridden(deedHash, approver, msg.sender, level, reason, signature);
    }

    /// @notice The exact text the device displays and signs.
    /// @dev Byte for byte the same as LedgerPort.message() in src/gate.js. The
    ///      deed hash is rendered as lowercase 0x-prefixed hex, which is what
    ///      viem's keccak256 returns, so the two sides agree without a
    ///      normalisation step that could drift.
    function approvalMessage(bytes32 deedHash, uint8 level, string memory reason)
        public
        pure
        returns (string memory)
    {
        return string.concat(
            "speculum approval\nverdict: ",
            levelName(level),
            "\nreason: ",
            reason,
            "\ndeed: ",
            toHexString(deedHash)
        );
    }

    /// @notice Who signed the approval, or the zero address if nobody did.
    /// @dev EIP-191 personal_sign, which is what signPersonalMessage produces.
    ///      Accepts v as 27/28 or 0/1; rejects any other length or value.
    function recoverApprover(
        bytes32 deedHash,
        uint8 level,
        string memory reason,
        bytes memory signature
    ) public pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes memory message = bytes(approvalMessage(deedHash, level, reason));
        bytes32 digest = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n", uintToString(message.length), message)
        );
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        // Reject the upper half of the s range, so each approval has exactly
        // one valid encoding and nobody can mint a second "different" override
        // from the same tap.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        return ecrecover(digest, v, r, s);
    }

    function levelName(uint8 level) internal pure returns (string memory) {
        if (level == PASS) return "PASS";
        if (level == BLOCK) return "BLOCK";
        if (level == REFUSE) return "REFUSE";
        revert("bad level");
    }

    function toHexString(bytes32 value) internal pure returns (string memory) {
        bytes16 alphabet = "0123456789abcdef";
        bytes memory out = new bytes(66);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i = 0; i < 32; i++) {
            out[2 + i * 2] = alphabet[uint8(value[i] >> 4)];
            out[3 + i * 2] = alphabet[uint8(value[i] & 0x0f)];
        }
        return string(out);
    }

    function uintToString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) { digits++; temp /= 10; }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + value % 10));
            value /= 10;
        }
        return string(buffer);
    }
}
