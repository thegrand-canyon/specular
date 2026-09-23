// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

interface IRegisterable {
    function register(string calldata agentURI, MetadataEntry[] calldata metadata) external returns (uint256);
    function addressToAgentId(address) external view returns (uint256);
}

struct MetadataEntry { string key; bytes value; }

/**
 * Attacker that attempts to RE-ENTER AgentRegistryV2.register() from inside the
 * onERC721Received callback fired during its own registration's _safeMint. If the
 * register() CEI fix holds (state written before _safeMint), the reentrant call
 * reverts with "Agent already registered" and mints no second agentId.
 */
contract MaliciousAgentReceiver is IERC721Receiver {
    IRegisterable public registry;
    bool public reentrantMinted; // true iff the reentrant register() unexpectedly succeeded
    bool public reentrantAttempted;

    constructor(address _registry) {
        registry = IRegisterable(_registry);
    }

    function attackRegister() external returns (uint256) {
        MetadataEntry[] memory empty;
        return registry.register("ipfs://malicious", empty);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        // Re-enter register during our own mint. Swallow the revert so the mint
        // itself completes — we only want to observe whether a 2nd id was minted.
        if (!reentrantAttempted) {
            reentrantAttempted = true;
            MetadataEntry[] memory empty;
            try registry.register("ipfs://reenter", empty) returns (uint256) {
                reentrantMinted = true;
            } catch {
                reentrantMinted = false;
            }
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}
