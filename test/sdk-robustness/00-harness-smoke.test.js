// Harness self-check: the fault-injecting transport really carries a full
// borrow→repay through the SDK, and rules fire where we expect.
const { expect } = require('chai');
const { deployV61, onboardOnChain, makeSdk, USDC } = require('./helpers/stack');
const { makeFaultyProvider, failMethod } = require('./helpers/faultProvider');
const { walletAt } = require('./helpers/wallets');

describe('robustness harness — smoke', function () {
    this.timeout(180000);

    it('drives a real borrow/repay through the interceptable transport', async () => {
        const d = await deployV61();
        const agentId = await onboardOnChain(d, d.borrower);
        const { provider, transport } = makeFaultyProvider();
        const w = walletAt(1, provider); // == d.borrower
        expect(w.address).to.equal(d.borrower.address);

        const { sdk, approvals } = makeSdk(w, d);
        expect(await sdk.marketplaceVersion()).to.equal('V6.1');
        const { loanId } = await sdk.borrow(100, 7);
        expect(approvals).to.deep.equal([USDC(100)]); // 100% collateral tier, exact
        await sdk.repay(loanId);
        expect(Number((await d.v6.loans(loanId)).state)).to.equal(2); // REPAID
        expect(await d.usdc.allowance(w.address, d.v6.target)).to.equal(0n);

        expect(transport.log.length).to.be.greaterThan(10);
        expect(transport.sent().length).to.be.greaterThan(0);
        void agentId;
    });

    it('an injected 500 really reaches the SDK', async () => {
        const { provider, transport } = makeFaultyProvider();
        transport.addRule(failMethod('eth_blockNumber', 500, 1));
        let threw = null;
        try { await provider.getBlockNumber(); } catch (e) { threw = e; }
        expect(threw, 'injected fault must surface').to.not.equal(null);
        expect(await provider.getBlockNumber()).to.be.a('number'); // rule is spent
    });
});
