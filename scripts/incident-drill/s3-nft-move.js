// SCENARIO 3 — the agent NFT moves while a loan is open (the F-01 class).
//
// Questions the runbook has to answer and has never rehearsed on V6.2:
//   * does the monitor's NFT-move detector actually fire, and at what severity?
//   * is the loan still closeable, and BY WHOM?
//   * where does the collateral go?
//   * who takes the reputation outcome?
//   * can the buyer borrow against the seller's locked self-stake? (M-1 lever)
//   * does owner liquidation still work after the transfer?
//
// Usage: npx hardhat run --network localhost scripts/incident-drill/s3-nft-move.js

const { ethers } = require('hardhat');
const L = require('./lib');
const { USDC, u, DAY, advance, attempt } = L;

async function main() {
    const a = L.addr();
    const signers = await ethers.getSigners();
    const owner = signers[0];
    const seller = signers[10];    // registers the agent, creates the pool, borrows
    const lender = signers[11];
    const buyer = signers[12];     // receives the agent NFT mid-loan
    const stranger = signers[13];

    const v6 = await ethers.getContractAt('AgentLiquidityMarketplaceV62', a.agentLiquidityMarketplace_v6);
    const rep = await ethers.getContractAt('ReputationManagerV4', a.reputationManagerV4);
    const reg = await ethers.getContractAt('AgentRegistryV2', a.agentRegistryV2);
    const usdc = await ethers.getContractAt('MockUSDC', a.usdc);

    const outer = await L.snap();
    for (const w of [seller, lender, buyer, stranger]) {
        await (await usdc.mint(w.address, USDC(100000))).wait();
        await (await usdc.connect(w).approve(await v6.getAddress(), ethers.MaxUint256)).wait();
    }
    await (await reg.connect(seller).register('ipfs://seller', [])).wait();
    const id = await reg.addressToAgentId(seller.address);
    await (await rep.connect(seller)['initializeReputation()']()).wait();
    await (await v6.connect(seller).createAgentPool()).wait();
    await (await v6.connect(lender).supplyLiquidity(id, USDC(1000))).wait();

    // Score 100 ⇒ tier 0 ⇒ 100 % collateral, bootstrap ladder limit 100 USDC.
    await (await v6.connect(seller).requestLoan(USDC(100), 7)).wait();
    const loanId = (await v6.nextLoanId()) - 1n;
    const loan = await v6.loans(loanId);

    // ------------------------------------------------------------ the transfer
    await advance(DAY);
    const txT = await (await reg.connect(seller).transferFrom(seller.address, buyer.address, id)).wait();

    const afterTransfer = {
        ownerOf: await reg.ownerOf(id),
        addressToAgentId_seller: Number(await reg.addressToAgentId(seller.address)),
        addressToAgentId_buyer: Number(await reg.addressToAgentId(buyer.address)),
        poolAgentAddress: (await v6.getAgentPool(id))[0],
        loanBorrower: loan.borrower,
        sellerStillHoldsLenderPosition: u((await v6.positions(id, seller.address)).amount),
        // D13: the self-stake view must resolve by agentId, not by the (now deleted)
        // seller address mapping.
        requiredSelfStakeView: u(await v6.requiredSelfStake(id, 0n)),
        transferGas: Number(txT.gasUsed),
    };

    // ---------------------------------------------------- DETECT: monitor reaction
    L.clearAlerts();
    const detect = L.runMonitor();
    const alerts = L.alertState();

    // ---------------------------------------------------- who can do what now
    const probes = [];
    const probe = async (label, fn) => {
        const s = await L.snap();
        probes.push({ ...(await attempt(label, fn)) });
        await L.revert(s);
    };
    await probe('stranger repays the loan', () => v6.connect(stranger).repayLoan(loanId));
    await probe('ORIGINAL borrower (seller) repays', () => v6.connect(seller).repayLoan(loanId));
    await probe('CURRENT NFT holder (buyer) repays', () => v6.connect(buyer).repayLoan(loanId));
    await probe('buyer requests a NEW loan (M-1 lever ON)', () => v6.connect(buyer).requestLoan(USDC(50), 7));
    await probe('seller requests a new loan after selling the NFT', () => v6.connect(seller).requestLoan(USDC(50), 7));
    await probe('buyer creates a pool for the transferred agent', () => v6.connect(buyer).createAgentPool());

    // ------------------------------------ branch A: the BUYER closes the loan
    const snapA = await L.snap();
    const balA0 = { seller: await usdc.balanceOf(seller.address), buyer: await usdc.balanceOf(buyer.address) };
    const scoreBefore = Number(await rep['getReputationScore(uint256)'](id));
    await advance(6 * DAY - 900);
    const rA = await (await v6.connect(buyer).repayLoan(loanId)).wait();
    const branchA = {
        repaidBy: 'current NFT holder (buyer)',
        loanState: Number((await v6.loans(loanId)).state),
        collateralReturnedTo_seller: u((await usdc.balanceOf(seller.address)) - balA0.seller),
        buyerNetSpend: u(balA0.buyer - (await usdc.balanceOf(buyer.address))),
        collateralAmount: u(loan.collateralAmount),
        scoreBefore, scoreAfter: Number(await rep['getReputationScore(uint256)'](id)),
        maxRepaidPrincipal: u(await rep.maxRepaidPrincipal(id)),
        gasUsed: Number(rA.gasUsed),
        monitorAfter: (() => { const r = L.runMonitor(); return { exitCode: r.exitCode, codes: r.codes }; })(),
    };
    await L.revert(snapA);

    // ------------------------------------ branch B: the ORIGINAL borrower closes it
    const snapB = await L.snap();
    const balB0 = { seller: await usdc.balanceOf(seller.address) };
    await advance(6 * DAY - 900);
    await (await v6.connect(seller).repayLoan(loanId)).wait();
    const branchB = {
        repaidBy: 'original borrower (seller), who no longer owns the agent',
        loanState: Number((await v6.loans(loanId)).state),
        sellerNetChange: u((await usdc.balanceOf(seller.address)) - balB0.seller),
        scoreAfter: Number(await rep['getReputationScore(uint256)'](id)),
        note: 'reputation still accrues to the agentId — i.e. to the BUYER, who now owns it',
    };
    await L.revert(snapB);

    // ------------------------------------ branch C: the loan goes bad after the sale
    const snapC = await L.snap();
    await advance(9 * DAY);
    const liq = await attempt('owner liquidates the transferred agent\'s loan', () => v6.connect(owner).liquidateLoan(loanId));
    const branchC = {
        liquidationWorksAfterTransfer: liq.ok, revert: liq.revert,
        loanState: Number((await v6.loans(loanId)).state),
        defaultRecordedAgainstAgentId: Number(await rep.defaultCount(id)),
        buyerLockedOut: await rep.isLockedOut(id),
        sellerLenderPositionAfter: u((await v6.positions(id, seller.address)).amount),
        collateralCoveredPrincipal: u(loan.collateralAmount) >= u(loan.amount),
    };
    await L.revert(snapC);

    const result = {
        scenario: 'S3 — agent NFT transferred mid-loan (F-01 class)',
        agentId: id.toString(), loanId: Number(loanId),
        loan: { principal: u(loan.amount), collateral: u(loan.collateralAmount) },
        afterTransfer,
        detection: {
            exitCode: detect.exitCode, codes: detect.codes,
            nftDetectorFired: detect.warns.includes('NFT-MOVED'),
            severity: detect.findings.find(f => f.code === 'NFT-MOVED')?.severity || null,
            alertLatched: alerts.latchExists,
            alertSeverity: alerts.latch ? alerts.latch.severity : null,
            monitorRuntimeMs: detect.ms,
        },
        whoCanDoWhat: probes,
        branchA_buyerRepays: branchA,
        branchB_sellerRepays: branchB,
        branchC_ownerLiquidates: branchC,
    };
    console.log(JSON.stringify(result, null, 2));
    L.writeResult('s3-nft-move.json', result);
    await L.revert(outer);
}

main().catch(e => { console.error(e); process.exit(1); });
