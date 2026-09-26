// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { CrossPermit } from "../src/CrossPermit.sol";
import { ERC7702Approver } from "../src/modules/ERC7702Approver.sol";
import { Script } from "forge-std/Script.sol";
import { console } from "forge-std/console.sol";

/**
 * @title DeployCrossPermit
 * @notice Deploys CrossPermit at the SAME address on every chain, through the ERC-2470 singleton
 *         factory.
 * @dev    This is not a convenience, it is a correctness requirement. The CrossPermit EIP-712 domain
 *         pins `chainId` to 1 so one signature covers every chain, but the domain still includes
 *         `verifyingContract` — so the signature only ports if the address matches everywhere.
 *         Identical init code plus an identical salt through the same factory is what guarantees it,
 *         which in turn is why every dependency in this repo is pinned to an exact commit.
 */
contract DeployCrossPermit is Script {
    /// @dev ERC-2470 singleton factory, at the same address on every EVM chain that has it.
    address public constant FACTORY = 0xce0042B868300000d44A59004Da54A005ffdcf9f;

    function run() external {
        bytes32 salt = vm.envBytes32("SALT");
        vm.rememberKey(vm.envUint("PRIVATE_KEY"));

        // Refuse rather than deploy to an address nobody can predict: on a chain without the
        // factory, CREATE2 through it is impossible and a plain CREATE would land somewhere else.
        require(FACTORY.code.length > 0, "ERC-2470 factory missing on this chain");

        vm.startBroadcast();

        address crossPermit = _deploy(type(CrossPermit).creationCode, salt);
        console.log("CrossPermit:", crossPermit);

        // Derived salt, so the approver is deterministic too without colliding with the core.
        address approver = _deploy(
            abi.encodePacked(type(ERC7702Approver).creationCode, abi.encode(crossPermit)),
            keccak256(abi.encode(salt, "ERC7702"))
        );
        console.log("ERC7702Approver:", approver);

        vm.stopBroadcast();
    }

    /**
     * @notice CREATE2 through the ERC-2470 factory.
     * @dev    The factory reverts if the address is already taken, so a re-run on a chain that is
     *         already deployed fails loudly. `script/deploy.sh` checks for existing code first and
     *         skips those chains, which is the path that makes a partial deploy resumable.
     */
    function _deploy(bytes memory initCode, bytes32 salt) internal returns (address deployed) {
        (bool ok, bytes memory ret) =
            FACTORY.call(abi.encodeWithSignature("deploy(bytes,bytes32)", initCode, salt));
        require(ok, "ERC-2470 deploy failed");
        deployed = abi.decode(ret, (address));
        require(deployed.code.length > 0, "factory returned an address with no code");
    }
}
