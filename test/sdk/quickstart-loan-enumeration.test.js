// [X-4, 2026-09-23 cross-generation regression round]
//
// The SDK discovers how many loans a wallet has by walking `agentLoans(addr, i)`
// until the call reverts (a Solidity array read past the end). Every such walk
// used `catch { break }` — so ANY failure ended the walk, and a transient RPC
// error was silently reported as "the array ends here".
//
// Measured on the live Arc endpoints on 2026-09-23: a rate-limited eth_call
// comes back as JSON-RPC `{code: -32005, "rate limit exceeded"}` and a genuine
// out-of-bounds read as `{code: 3, "execution reverted"}` — and ethers v6
// collapses BOTH into `CALL_EXCEPTION: missing revert data` with `data: null`
// and `reason: null`. Only `info.error.code` separates them, and nothing looked.
//
// Consequences, all silent:
//   * `loans()` reports a truncated (often EMPTY) loan list — an agent reads
//     "no outstanding debt" while a loan is live.
//   * `_loanCount()` under-counts, and it is the `countBefore` that
//     `_reconcileNewLoan()` compares against after an inconclusive borrow: an
//     under-count makes the reconciler "adopt" an OLD loan id as the new loan.
//   * `activeLoanIds()`'s V6 fallback truncates the same way.
//   * `canTopUp()` answered `true` (the permissive answer) on any failure.
//
// A genuine end-of-array must still terminate the walk — that is the control.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { SpecularQuickstart } = require("../../src/sdk/SpecularQuickstart.js");

const USDC = (n) => ethers.parseUnits(n.toString(), 6);
const DAY = 86400;

/** What ethers v6 produces when the RPC answers eth_call with a JSON-RPC error. */
function rpcCallError(code, message) {
    return Object.assign(new Error("missing revert data"), {
        code: "CALL_EXCEPTION", action: "call", data: null, reason: null,
        invocation: null, revert: null, shortMessage: "missing revert data",
        info: { error: { code, message }, payload: { method: "eth_call", params: [] } },
    });
}
const rateLimited = () => rpcCallError(-32005, "rate limit exceeded");
const revertedNoData = () => rpcCallError(3, "execution reverted");

/** A SpecularQuickstart whose marketplace reads are driven by `loanIds`. */
function sdkWithLoans({ loanIds, failAt, failWith }) {
    const wallet = { address: "0x1111111111111111111111111111111111111111", provider: { getBlockNumber: async () => 1 } };
    const sdk = Object.create(SpecularQuickstart.prototype);
    sdk.wallet = wallet;
    sdk.network = "test";
    sdk.cfg = { decimals: 6, explorer: "" };
    sdk.stalenessCheck = false;
    sdk.maxBlockLagSeconds = 0;
    sdk.addresses = { marketplace: "0x2222222222222222222222222222222222222222" };
    sdk._mpVersion = "V6"; // V6 generation: activeLoanIds() must take the walking fallback
    const calls = { agentLoans: 0, canTopUp: 0 };
    sdk.marketplace = {
        agentLoans: async (_addr, i) => {
            calls.agentLoans += 1;
            const idx = Number(i);
            if (failAt !== undefined && idx === failAt) throw failWith();
            if (idx >= loanIds.length) throw revertedNoData();
            return BigInt(loanIds[idx]);
        },
        loans: async (id) => ({ amount: USDC(1), interestRate: 1500n, state: 1n, endTime: 0n, id }),
        agentPools: async () => ({ agentAddress: wallet.address }),
        canTopUp: async () => { calls.canTopUp += 1; throw failWith ? failWith() : revertedNoData(); },
    };
    return { sdk, calls };
}

describe("SpecularQuickstart loan enumeration — a transient RPC error is not 'end of array'", function () {
    it("control: a genuine out-of-bounds revert ends the walk and the list is complete", async function () {
        const { sdk } = sdkWithLoans({ loanIds: [7, 8, 9] });
        const loans = await sdk.loans();
        expect(loans.map((l) => l.id)).to.deep.equal([7, 8, 9]);
        expect(await sdk._loanCount()).to.equal(3);
        expect(await sdk.activeLoanIds(1)).to.deep.equal([7, 8, 9]);
    });

    it("loans() must THROW on a rate limit, never return a truncated list", async function () {
        const { sdk } = sdkWithLoans({ loanIds: [7, 8, 9], failAt: 1, failWith: rateLimited });
        let err = null;
        let out = null;
        try { out = await sdk.loans(); } catch (e) { err = e; }
        expect(err, `loans() returned ${JSON.stringify(out)} instead of throwing`).to.not.equal(null);
        expect(err.code).to.equal("SPECULAR_LOAN_ENUMERATION_FAILED");
        expect(err.message).to.match(/truncated|rate limit|enumerat/i);
    });

    it("_loanCount() must THROW rather than under-count (it is borrow's reconciliation baseline)", async function () {
        const { sdk } = sdkWithLoans({ loanIds: [7, 8, 9], failAt: 1, failWith: rateLimited });
        let err = null;
        let n = null;
        try { n = await sdk._loanCount(); } catch (e) { err = e; }
        expect(err, `_loanCount() returned ${n} instead of throwing`).to.not.equal(null);
        expect(err.code).to.equal("SPECULAR_LOAN_ENUMERATION_FAILED");
    });

    it("activeLoanIds() V6 fallback must THROW rather than silently drop loans", async function () {
        const { sdk } = sdkWithLoans({ loanIds: [7, 8, 9], failAt: 2, failWith: rateLimited });
        let err = null;
        let out = null;
        try { out = await sdk.activeLoanIds(1); } catch (e) { err = e; }
        expect(err, `activeLoanIds() returned ${JSON.stringify(out)} instead of throwing`).to.not.equal(null);
        expect(err.code).to.equal("SPECULAR_LOAN_ENUMERATION_FAILED");
    });

    it("canTopUp() must not answer the permissive 'true' when the RPC failed", async function () {
        const { sdk } = sdkWithLoans({ loanIds: [], failWith: rateLimited });
        sdk._mpVersion = "V6.1"; // canTopUp only exists from V6.1
        let err = null;
        let ans = null;
        try { ans = await sdk.canTopUp(1); } catch (e) { err = e; }
        expect(err, `canTopUp() answered ${ans} instead of throwing`).to.not.equal(null);
    });

    it("canTopUp() still degrades to true when the selector is genuinely absent", async function () {
        const { sdk } = sdkWithLoans({ loanIds: [], failWith: revertedNoData });
        sdk._mpVersion = "V6.1";
        expect(await sdk.canTopUp(1)).to.equal(true);
    });
});

describe("SpecularQuickstart.isAllowanceShortfall — 'exceeds' is not always an allowance", function () {
    // [X-9] The bare /exceeds/i test matched "Exceeds credit limit", so the borrow
    // path treated a credit-limit refusal as an allowance shortfall and re-approved
    // collateral + principal. Measured in the 2026-09-23 write-parity round: a
    // borrow that could never succeed approved 1200 USDC, then 2400 USDC, then 0.
    const revert = (reason) => Object.assign(new Error(`execution reverted: "${reason}"`), {
        code: "CALL_EXCEPTION", reason, data: "0x08c379a0",
    });

    it("does NOT treat a credit-limit refusal as an allowance shortfall", function () {
        expect(SpecularQuickstart.isAllowanceShortfall(revert("Exceeds credit limit"))).to.equal(false);
    });

    it("does NOT treat a liquidity refusal as an allowance shortfall", function () {
        expect(SpecularQuickstart.isAllowanceShortfall(revert("Exceeds pool liquidity"))).to.equal(false);
    });

    it("still recognises a genuine allowance shortfall (legacy string revert)", function () {
        expect(SpecularQuickstart.isAllowanceShortfall(revert("ERC20: transfer amount exceeds allowance"))).to.equal(true);
    });

    it("still recognises the OpenZeppelin v5 custom error", function () {
        const e = Object.assign(new Error("execution reverted (unknown custom error)"), {
            code: "CALL_EXCEPTION", data: SpecularQuickstart.ERC20_INSUFFICIENT_ALLOWANCE + "00".repeat(96),
        });
        expect(SpecularQuickstart.isAllowanceShortfall(e)).to.equal(true);
    });
});

describe("SpecularQuickstart._codeHasSelector — selectors with a leading zero byte", function () {
    // solc emits the dispatcher constant as PUSH3 when the 4-byte selector
    // starts with 0x00 (PUSH4 0x004d9045 === PUSH3 0x4d9045 numerically), so a
    // substring scan of the deployed bytecode reports the function ABSENT even
    // though it is implemented and answers. Verified on the live Arc mainnet
    // V6.2 at 0xCb23f2fb03Bfd4775Cc0e76E28f64c1e545071be, where
    // `minHoldForReputationReward()` (selector 0x004d9045) returns 86400 while
    // the bytes 004d9045 never appear in its code. ~1 in 256 functions.
    it("finds a function whose selector begins with 0x00", async function () {
        const iface = new ethers.Interface(["function minHoldForReputationReward() view returns (uint256)"]);
        expect(iface.getFunction("minHoldForReputationReward").selector).to.equal("0x004d9045");

        const sdk = Object.create(SpecularQuickstart.prototype);
        sdk.addresses = { marketplace: "0x2222222222222222222222222222222222222222" };
        sdk.marketplace = { interface: iface };
        sdk.wallet = {
            address: "0x1111111111111111111111111111111111111111",
            // dispatcher as solc actually emits it: PUSH3 (0x62) + the low 3 bytes
            provider: { getCode: async () => "0x6080604052624d904581146100205780..." },
        };
        expect(await sdk._codeHasSelector("minHoldForReputationReward")).to.equal(true);
    });

    it("still reports a genuinely absent selector as absent", async function () {
        const iface = new ethers.Interface(["function minHoldForReputationReward() view returns (uint256)"]);
        const sdk = Object.create(SpecularQuickstart.prototype);
        sdk.addresses = { marketplace: "0x2222222222222222222222222222222222222222" };
        sdk.marketplace = { interface: iface };
        sdk.wallet = {
            address: "0x1111111111111111111111111111111111111111",
            provider: { getCode: async () => "0x60806040526312345678811461002057806387654321146100305780" },
        };
        expect(await sdk._codeHasSelector("minHoldForReputationReward")).to.equal(false);
    });
});
