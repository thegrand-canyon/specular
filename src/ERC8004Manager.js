const { ethers } = require('ethers');
const Formatter = require('./utils/formatting');
const { ValidationError } = require('./utils/errors');

/**
 * @class ERC8004Manager
 * @description Manages ERC-8004 functionality: agent NFTs, feedback, and validation
 */
class ERC8004Manager {
    constructor(wallet, contracts) {
        this.wallet = wallet;
        this.contracts = contracts;
        this.agentId = null;
    }

    /**
     * Get agent ID for the current wallet
     * @returns {number} Agent NFT ID
     */
    async getAgentId() {
        if (this.agentId) return this.agentId;

        const agentId = await this.contracts.agentRegistry.addressToAgentId(this.wallet.address);
        if (agentId === 0n) {
            throw new Error('Agent not registered');
        }

        this.agentId = Number(agentId);
        return this.agentId;
    }

    // ========== Identity Registry (ERC-721) ==========

    /**
     * Register a new agent and mint NFT
     * @param {string} agentURI - URI pointing to agent metadata (IPFS, HTTP, etc.)
     * @param {Array} metadata - Array of {key, value} metadata entries
     * @returns {Object} Transaction receipt and agent ID
     */
    async registerAgentNFT(agentURI, metadata = []) {
        console.log('Registering agent NFT...');

        // Convert metadata to contract format
        const metadataEntries = metadata.map(m => ({
            key: m.key,
            value: ethers.toUtf8Bytes(typeof m.value === 'string' ? m.value : JSON.stringify(m.value))
        }));

        const tx = await this.contracts.agentRegistry.register(agentURI, metadataEntries);
        console.log(`Transaction sent: ${tx.hash}`);

        const receipt = await tx.wait();
        console.log(`Agent NFT registered in block ${receipt.blockNumber}`);

        // Parse AgentRegistered event to get agent ID
        const event = receipt.logs
            .map(log => {
                try {
                    return this.contracts.agentRegistry.interface.parseLog(log);
                } catch (e) {
                    return null;
                }
            })
            .find(e => e && e.name === 'AgentRegistered');

        if (event) {
            this.agentId = Number(event.args.agentId);
            console.log(`Agent ID: ${this.agentId}`);
        }

        return {
            receipt,
            agentId: this.agentId,
            txHash: tx.hash
        };
    }

    /**
     * Update agent URI
     * @param {string} newURI - New URI for agent metadata
     * @returns {Object} Transaction receipt
     */
    async updateAgentURI(newURI) {
        const agentId = await this.getAgentId();

        const tx = await this.contracts.agentRegistry.setAgentURI(agentId, newURI);
        const receipt = await tx.wait();

        console.log(`Agent URI updated in block ${receipt.blockNumber}`);
        return receipt;
    }

    /**
     * Get custom metadata for the agent
     * @param {string} key - Metadata key
     * @returns {string} Metadata value
     */
    async getMetadata(key) {
        const agentId = await this.getAgentId();

        const valueBytes = await this.contracts.agentRegistry.getMetadata(agentId, key);
        return ethers.toUtf8String(valueBytes);
    }

    /**
     * Set custom metadata for the agent
     * @param {string} key - Metadata key
     * @param {string|Object} value - Metadata value
     * @returns {Object} Transaction receipt
     */
    async setMetadata(key, value) {
        const agentId = await this.getAgentId();

        const valueBytes = ethers.toUtf8Bytes(
            typeof value === 'string' ? value : JSON.stringify(value)
        );

        const tx = await this.contracts.agentRegistry.setMetadata(agentId, key, valueBytes);
        const receipt = await tx.wait();

        console.log(`Metadata '${key}' updated in block ${receipt.blockNumber}`);
        return receipt;
    }

    /**
     * Get agent NFT owner
     * @returns {string} Owner address
     */
    async getAgentOwner() {
        const agentId = await this.getAgentId();
        return await this.contracts.agentRegistry.ownerOf(agentId);
    }

    /**
     * Transfer agent NFT to another address
     * @param {string} toAddress - Recipient address
     * @returns {Object} Transaction receipt
     */
    async transferAgentNFT(toAddress) {
        const agentId = await this.getAgentId();

        const tx = await this.contracts.agentRegistry.transferFrom(
            this.wallet.address,
            toAddress,
            agentId
        );
        const receipt = await tx.wait();

        console.log(`Agent NFT transferred to ${toAddress} in block ${receipt.blockNumber}`);
        return receipt;
    }

    // ========== Reputation Registry ==========

    /**
     * Submit feedback for an agent
     * @param {number} targetAgentId - Agent ID to give feedback to
     * @param {number} score - Feedback score (can be negative)
     * @param {Object} options - Feedback options (tag1, tag2, endpoint, feedbackURI)
     * @returns {Object} Transaction receipt and feedback hash
     */
    async giveFeedback(targetAgentId, score, options = {}) {
        const {
            tag1 = '',
            tag2 = '',
            endpoint = '',
            feedbackURI = '',
            decimals = 0
        } = options;

        console.log(`Submitting feedback for agent ${targetAgentId}...`);

        const tx = await this.contracts.reputationManager.giveFeedback(
            targetAgentId,
            score,
            decimals,
            tag1,
            tag2,
            endpoint,
            feedbackURI,
            ethers.ZeroHash // Let contract generate hash
        );

        const receipt = await tx.wait();

        // Parse FeedbackGiven event
        const event = receipt.logs
            .map(log => {
                try {
                    return this.contracts.reputationManager.interface.parseLog(log);
                } catch (e) {
                    return null;
                }
            })
            .find(e => e && e.name === 'FeedbackGiven');

        const feedbackHash = event ? event.args.feedbackHash : null;

        console.log(`Feedback submitted. Hash: ${feedbackHash}`);

        return {
            receipt,
            feedbackHash,
            txHash: tx.hash
        };
    }

    /**
     * Read a specific feedback entry
     * @param {string} feedbackHash - Feedback hash
     * @returns {Object} Feedback data
     */
    async readFeedback(feedbackHash) {
        const feedback = await this.contracts.reputationManager.readFeedback(feedbackHash);

        return {
            agentId: Number(feedback.agentId),
            clientAddress: feedback.clientAddress,
            value: Number(feedback.value),
            valueDecimals: feedback.valueDecimals,
            tag1: feedback.tag1,
            tag2: feedback.tag2,
            endpoint: feedback.endpoint,
            feedbackURI: feedback.feedbackURI,
            timestamp: Number(feedback.timestamp),
            revoked: feedback.revoked,
            response: feedback.response
        };
    }

    /**
     * Get all feedback for an agent
     * @param {number} agentId - Agent ID (defaults to current agent)
     * @param {Object} filters - Optional filters (clientAddresses, tags)
     * @returns {Array} Array of feedback entries
     */
    async getAllFeedback(agentId = null, filters = {}) {
        if (!agentId) {
            agentId = await this.getAgentId();
        }

        const { clientAddresses = [], tags = [] } = filters;

        const feedbacks = await this.contracts.reputationManager.readAllFeedback(
            agentId,
            clientAddresses,
            tags
        );

        return feedbacks.map(fb => ({
            agentId: Number(fb.agentId),
            clientAddress: fb.clientAddress,
            value: Number(fb.value),
            valueDecimals: fb.valueDecimals,
            tag1: fb.tag1,
            tag2: fb.tag2,
            endpoint: fb.endpoint,
            feedbackURI: fb.feedbackURI,
            timestamp: Number(fb.timestamp),
            revoked: fb.revoked,
            response: fb.response
        }));
    }

    /**
     * Get aggregated feedback summary
     * @param {number} agentId - Agent ID (defaults to current agent)
     * @param {Object} filters - Optional filters
     * @returns {Object} Summary stats
     */
    async getFeedbackSummary(agentId = null, filters = {}) {
        if (!agentId) {
            agentId = await this.getAgentId();
        }

        const { clientAddresses = [], tags = [] } = filters;

        const summary = await this.contracts.reputationManager.getSummary(
            agentId,
            clientAddresses,
            tags.length > 0 ? tags[0] : ''
        );

        return {
            count: Number(summary.count),
            averageValue: Number(summary.averageValue),
            minValue: Number(summary.minValue),
            maxValue: Number(summary.maxValue)
        };
    }

    /**
     * Revoke previously submitted feedback
     * @param {string} feedbackHash - Hash of feedback to revoke
     * @returns {Object} Transaction receipt
     */
    async revokeFeedback(feedbackHash) {
        console.log(`Revoking feedback ${feedbackHash}...`);

        const tx = await this.contracts.reputationManager.revokeFeedback(feedbackHash);
        const receipt = await tx.wait();

        console.log(`Feedback revoked in block ${receipt.blockNumber}`);
        return receipt;
    }

    /**
     * Append response to feedback
     * @param {string} feedbackHash - Hash of feedback
     * @param {string} response - Response text
     * @returns {Object} Transaction receipt
     */
    async respondToFeedback(feedbackHash, response) {
        console.log(`Responding to feedback ${feedbackHash}...`);

        const tx = await this.contracts.reputationManager.appendResponse(feedbackHash, response);
        const receipt = await tx.wait();

        console.log(`Response added in block ${receipt.blockNumber}`);
        return receipt;
    }

    // ========== Validation Registry ==========

    /**
     * Request validation from a validator
     * @param {string} validatorAddress - Validator's address
     * @param {Object} options - Request options (agentId, requestURI)
     * @returns {Object} Transaction receipt and request hash
     */
    async requestValidation(validatorAddress, options = {}) {
        const agentId = options.agentId || await this.getAgentId();
        const requestURI = options.requestURI || '';

        console.log(`Requesting validation from ${validatorAddress}...`);

        const tx = await this.contracts.validationRegistry.validationRequest(
            validatorAddress,
            agentId,
            requestURI,
            ethers.ZeroHash // Let contract generate hash
        );

        const receipt = await tx.wait();

        // Parse ValidationRequested event
        const event = receipt.logs
            .map(log => {
                try {
                    return this.contracts.validationRegistry.interface.parseLog(log);
                } catch (e) {
                    return null;
                }
            })
            .find(e => e && e.name === 'ValidationRequested');

        const requestHash = event ? event.args.requestHash : null;

        console.log(`Validation requested. Hash: ${requestHash}`);

        return {
            receipt,
            requestHash,
            txHash: tx.hash
        };
    }

    /**
     * Get validation status
     * @param {string} requestHash - Validation request hash
     * @returns {Object} Validation data
     */
    async getValidationStatus(requestHash) {
        const validation = await this.contracts.validationRegistry.getValidationStatus(requestHash);

        const statusMap = ['PENDING', 'APPROVED', 'REJECTED', 'DISPUTED'];

        return {
            requestHash: validation.requestHash,
            agentId: Number(validation.agentId),
            requester: validation.requester,
            validatorAddress: validation.validatorAddress,
            requestURI: validation.requestURI,
            timestamp: Number(validation.timestamp),
            status: statusMap[validation.status],
            responseScore: validation.responseScore,
            responseURI: validation.responseURI,
            tag: validation.tag
        };
    }

    /**
     * Get validation summary for an agent
     * @param {number} agentId - Agent ID (defaults to current agent)
     * @param {Object} filters - Optional filters
     * @returns {Object} Validation summary
     */
    async getValidationSummary(agentId = null, filters = {}) {
        if (!agentId) {
            agentId = await this.getAgentId();
        }

        const { validatorAddresses = [], tag = '' } = filters;

        const summary = await this.contracts.validationRegistry.getSummary(
            agentId,
            validatorAddresses,
            tag
        );

        return {
            totalCount: Number(summary.totalCount),
            approvedCount: Number(summary.approvedCount),
            rejectedCount: Number(summary.rejectedCount),
            averageScore: Number(summary.averageScore)
        };
    }

    /**
     * Get all approved validators
     * @returns {Array} Array of validator addresses
     */
    async getApprovedValidators() {
        return await this.contracts.validationRegistry.getApprovedValidators();
    }

    /**
     * Dispute a validation result
     * @param {string} requestHash - Validation request hash
     * @returns {Object} Transaction receipt
     */
    async disputeValidation(requestHash) {
        console.log(`Disputing validation ${requestHash}...`);

        const tx = await this.contracts.validationRegistry.disputeValidation(requestHash);
        const receipt = await tx.wait();

        console.log(`Validation disputed in block ${receipt.blockNumber}`);
        return receipt;
    }
}

module.exports = ERC8004Manager;
