/**
 * Custom error classes for the Specular SDK
 */

class SpecularError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SpecularError';
    }
}

class RegistrationError extends SpecularError {
    constructor(message) {
        super(message);
        this.name = 'RegistrationError';
    }
}

class InsufficientReputationError extends SpecularError {
    constructor(message, currentScore, requiredScore) {
        super(message);
        this.name = 'InsufficientReputationError';
        this.currentScore = currentScore;
        this.requiredScore = requiredScore;
    }
}

class LoanError extends SpecularError {
    constructor(message, loanId) {
        super(message);
        this.name = 'LoanError';
        this.loanId = loanId;
    }
}

class ContractInteractionError extends SpecularError {
    constructor(message, contractName, methodName) {
        super(message);
        this.name = 'ContractInteractionError';
        this.contractName = contractName;
        this.methodName = methodName;
    }
}

class ValidationError extends SpecularError {
    constructor(message, field) {
        super(message);
        this.name = 'ValidationError';
        this.field = field;
    }
}

module.exports = {
    SpecularError,
    RegistrationError,
    InsufficientReputationError,
    LoanError,
    ContractInteractionError,
    ValidationError
};
