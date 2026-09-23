// Regression test for StateManager L8: per-key cache freshness.
//
// Old behavior: one shared `lastUpdate`, set only by syncState(). Individual
// refreshX() calls didn't update it, so their fresh data read as stale, while
// syncState marked never-refreshed keys as fresh. Fixed with per-key timestamps
// stamped on each successful refresh.

const { expect } = require("chai");
const StateManager = require("../../src/StateManager.js");

function mockAgent() {
    return {
        address: "0xabc",
        contracts: {
            reputationManager: {
                "getReputationScore(address)": async () => 950n,
                "calculateCreditLimit(address)": async () => 50000000000n,
                "calculateCollateralRequirement(address)": async () => 0n,
            },
            agentRegistry: {
                getAgentInfo: async () => ({ agentAddress: "0xabc", metadata: "m", registrationTime: 1n, isActive: true }),
            },
            lendingPool: { getBorrowerLoans: async () => [], getLoan: async () => ({}) },
        },
    };
}

describe("StateManager per-key freshness (L8)", function () {
    it("marks only the keys an individual refresh populated as fresh", async () => {
        const sm = new StateManager(mockAgent());
        expect(sm.isCacheValid("reputation")).to.equal(false); // cold

        await sm.refreshReputation();
        expect(sm.isCacheValid("reputation")).to.equal(true);
        expect(sm.isCacheValid("creditLimit")).to.equal(true);
        expect(sm.isCacheValid("collateralRequirement")).to.equal(true);
        // agentInfo was never refreshed — must NOT read as fresh
        expect(sm.isCacheValid("agentInfo")).to.equal(false);
    });

    it("serves a fresh cache without refetching", async () => {
        const agent = mockAgent();
        const sm = new StateManager(agent);
        await sm.refreshReputation();
        let refetch = 0;
        agent.contracts.reputationManager["getReputationScore(address)"] = async () => { refetch++; return 111n; };
        const rep = await sm.getReputation();
        expect(rep).to.equal(950);
        expect(refetch).to.equal(0);
    });

    it("expires a key after its TTL", async () => {
        const sm = new StateManager(mockAgent());
        await sm.refreshReputation();
        sm.setCacheTTL(1);
        await new Promise((r) => setTimeout(r, 5));
        expect(sm.isCacheValid("reputation")).to.equal(false);
    });

    it("invalidateKey clears that key's freshness", async () => {
        const sm = new StateManager(mockAgent());
        await sm.refreshReputation();
        sm.invalidateKey("reputation");
        expect(sm.isCacheValid("reputation")).to.equal(false);
        // sibling key untouched
        expect(sm.isCacheValid("creditLimit")).to.equal(true);
    });
});
