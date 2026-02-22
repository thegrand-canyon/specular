const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const { ContractInteractionError } = require('./utils/errors');

/**
 * Manages contract instances and interactions
 */
class ContractManager {
    constructor(provider, contractAddresses) {
        this.provider = provider;
        this.contractAddresses = contractAddresses;
        this.contracts = {};
        this.abis = {};

        this.loadABIs();
    }

    /**
     * Load contract ABIs from the abis directory
     */
    loadABIs() {
        const abiDir = path.join(__dirname, '../abis');
        const contractNames = [
            'AgentRegistry', 'ReputationManager', 'LendingPool', 'MockUSDC',
            'AgentRegistryV2', 'ReputationManagerV2', 'LendingPoolV2', 'ValidationRegistry'
        ];

        for (const name of contractNames) {
            const abiPath = path.join(abiDir, `${name}.json`);
            if (fs.existsSync(abiPath)) {
                this.abis[name] = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
            }
            // Don't throw error if V2 contracts don't exist (backwards compatibility)
        }
    }

    /**
     * Get a contract instance with a signer
     */
    getContract(contractName, signer) {
        // Try exact match first, then lowercase first letter, then strip V2 suffix
        let address = this.contractAddresses[contractName];

        if (!address) {
            const lowerFirst = contractName.charAt(0).toLowerCase() + contractName.slice(1);
            address = this.contractAddresses[lowerFirst];
        }

        // Handle V2 contracts - look for address without V2 suffix
        if (!address && contractName.endsWith('V2')) {
            const nameWithoutV2 = contractName.slice(0, -2);
            address = this.contractAddresses[nameWithoutV2];

            if (!address) {
                const lowerFirst = nameWithoutV2.charAt(0).toLowerCase() + nameWithoutV2.slice(1);
                address = this.contractAddresses[lowerFirst];
            }
        }

        const abi = this.abis[contractName];

        if (!address) {
            throw new ContractInteractionError(
                `Contract address not found for ${contractName}`,
                contractName,
                'getContract'
            );
        }

        if (!abi) {
            throw new ContractInteractionError(
                `ABI not found for ${contractName}`,
                contractName,
                'getContract'
            );
        }

        return new ethers.Contract(address, abi, signer);
    }

    /**
     * Call a contract method with error handling and retry logic
     */
    async callContract(contract, methodName, params = [], options = {}) {
        const maxRetries = options.retries || 3;
        const retryDelay = options.retryDelay || 1000;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // Estimate gas if it's a transaction
                if (options.estimateGas) {
                    const gasEstimate = await contract[methodName].estimateGas(...params);
                    options.gasLimit = gasEstimate * 120n / 100n; // Add 20% buffer
                }

                // Call the method
                const result = await contract[methodName](...params, options);

                // If it's a transaction, wait for confirmation
                if (result && typeof result.wait === 'function') {
                    const receipt = await result.wait();
                    return { transaction: result, receipt };
                }

                return result;
            } catch (error) {
                // Don't retry on validation errors
                if (error.message.includes('reverted') ||
                    error.message.includes('invalid') ||
                    attempt === maxRetries) {
                    throw new ContractInteractionError(
                        `Failed to call ${methodName}: ${error.message}`,
                        contract.target,
                        methodName
                    );
                }

                // Wait before retrying
                await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
            }
        }
    }

    /**
     * Parse event logs from a transaction receipt
     */
    parseEventLogs(receipt, contract, eventName) {
        const events = [];

        for (const log of receipt.logs) {
            try {
                const parsed = contract.interface.parseLog(log);
                if (parsed && parsed.name === eventName) {
                    events.push(parsed);
                }
            } catch (error) {
                // Skip logs that don't match the contract
                continue;
            }
        }

        return events;
    }

    /**
     * Get transaction receipt with retry
     */
    async getReceipt(txHash, maxWait = 60000) {
        const startTime = Date.now();

        while (Date.now() - startTime < maxWait) {
            const receipt = await this.provider.getTransactionReceipt(txHash);
            if (receipt) {
                return receipt;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        throw new Error(`Transaction ${txHash} not mined within ${maxWait}ms`);
    }

    /**
     * Convert camelCase to snake_case for address lookup
     */
    camelToSnake(str) {
        return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`).replace(/^_/, '');
    }

    /**
     * Get all contract addresses
     */
    getAddresses() {
        return this.contractAddresses;
    }
}

module.exports = ContractManager;
