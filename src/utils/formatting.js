const { ethers } = require('ethers');

/**
 * Data formatting utilities
 */

class Formatter {
    /**
     * Format USDC amount from token units (6 decimals) to human-readable
     */
    static formatUSDC(amount) {
        return ethers.formatUnits(amount, 6);
    }

    /**
     * Parse USDC amount from human-readable to token units (6 decimals)
     */
    static parseUSDC(amount) {
        return ethers.parseUnits(amount.toString(), 6);
    }

    /**
     * Format timestamp to human-readable date
     */
    static formatTimestamp(timestamp) {
        return new Date(Number(timestamp) * 1000).toISOString();
    }

    /**
     * Format loan state enum to string
     */
    static formatLoanState(state) {
        const states = ['REQUESTED', 'APPROVED', 'ACTIVE', 'REPAID', 'DEFAULTED'];
        return states[Number(state)] || 'UNKNOWN';
    }

    /**
     * Format interest rate from basis points to percentage
     */
    static formatInterestRate(basisPoints) {
        return (Number(basisPoints) / 100).toFixed(2) + '%';
    }

    /**
     * Format reputation score with category
     */
    static formatReputation(score) {
        const numScore = Number(score);
        let category;

        if (numScore >= 800) category = 'Excellent';
        else if (numScore >= 600) category = 'Good';
        else if (numScore >= 400) category = 'Fair';
        else if (numScore >= 200) category = 'Poor';
        else category = 'Very Poor';

        return {
            score: numScore,
            category,
            display: `${numScore}/1000 (${category})`
        };
    }

    /**
     * Shorten Ethereum address for display
     */
    static shortenAddress(address) {
        if (!address) return '';
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }
}

module.exports = Formatter;
