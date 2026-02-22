const { ValidationError } = require('./errors');

/**
 * Validation utilities for SDK inputs
 */

class Validator {
    /**
     * Validate Ethereum address
     */
    static isValidAddress(address) {
        return /^0x[a-fA-F0-9]{40}$/.test(address);
    }

    /**
     * Validate metadata string
     */
    static validateMetadata(metadata) {
        if (typeof metadata !== 'string') {
            throw new ValidationError('Metadata must be a string', 'metadata');
        }
        if (metadata.length === 0) {
            throw new ValidationError('Metadata cannot be empty', 'metadata');
        }
        if (metadata.length > 1000) {
            throw new ValidationError('Metadata too long (max 1000 characters)', 'metadata');
        }
        return true;
    }

    /**
     * Validate loan amount
     */
    static validateLoanAmount(amount) {
        if (typeof amount !== 'number' || amount <= 0) {
            throw new ValidationError('Loan amount must be a positive number', 'amount');
        }
        if (amount > 1000000) {
            throw new ValidationError('Loan amount too large (max 1,000,000 USDC)', 'amount');
        }
        return true;
    }

    /**
     * Validate loan duration
     */
    static validateLoanDuration(durationDays) {
        if (typeof durationDays !== 'number' || durationDays <= 0) {
            throw new ValidationError('Duration must be a positive number', 'durationDays');
        }
        if (durationDays > 365) {
            throw new ValidationError('Duration too long (max 365 days)', 'durationDays');
        }
        return true;
    }

    /**
     * Validate loan ID
     */
    static validateLoanId(loanId) {
        const id = Number(loanId);
        if (!Number.isInteger(id) || id < 0) {
            throw new ValidationError('Loan ID must be a non-negative integer', 'loanId');
        }
        return true;
    }
}

module.exports = Validator;
