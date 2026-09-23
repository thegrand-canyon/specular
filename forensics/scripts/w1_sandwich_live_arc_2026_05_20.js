// Live W1 sandwich attack on the NEW Arc V6 (0x7a0560...) — proves the fix is
// correctly compiled into the deployed bytecode, not just in unit tests.
//
// Scenario:
//   1. legitLender supplies 100 USDC BEFORE the loan request
//   2. borrower requests loan
//   3. attacker supplies 1000 USDC AFTER the loan started (the sandwich)
//   4. borrower repays — distribution should ignore attacker
//   5. attacker's earnedInterest should be 0; legit gets full share

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const V6 = ADDR.agentLiquidityMarketplace_v6;
const ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json')).abi;
const REG_ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json')).abi;
const USDC_ABI = ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rT(fn, n=15) { for (let i=0;i<n;i++){try{return await fn();}catch(e){if(i===n-1)throw e; await sleep(2000*(i+1));}} }

(async () => {
    const provider = new ethers.JsonRpcProvider(process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org', undefined, { batchMaxCount: 1 });
    const owner = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const v6 = new ethers.Contract(V6, ABI, owner);
    const reg = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, owner);
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, owner);

    console.log('=== W1 SANDWICH DEFENSE — LIVE on Arc V6 ===');
    console.log('V6:', V6);
    const legit = ethers.Wallet.createRandom().connect(provider);
    const borrower = ethers.Wallet.createRandom().connect(provider);
    const attacker = ethers.Wallet.createRandom().connect(provider);
    fs.writeFileSync('./forensics/output/regression-2026-05-07/90-w1live-wallets.json', JSON.stringify({
        legit: { addr: legit.address, key: legit.privateKey },
        borrower: { addr: borrower.address, key: borrower.privateKey },
        attacker: { addr: attacker.address, key: attacker.privateKey }
    }, null, 2));
    console.log('legit:', legit.address);
    console.log('borrower:', borrower.address);
    console.log('attacker:', attacker.address);

    // Fund
    console.log('\n[1] Funding ephemeral wallets');
    for (const w of [legit, borrower, attacker]) {
        await rT(() => owner.sendTransaction({ to: w.address, value: ethers.parseEther('0.3') }).then(t => t.wait()));
        await sleep(1000);
    }
    await rT(() => usdc.transfer(legit.address, ethers.parseUnits('200', 6)).then(t => t.wait()));
    await rT(() => usdc.transfer(borrower.address, ethers.parseUnits('100', 6)).then(t => t.wait()));
    await rT(() => usdc.transfer(attacker.address, ethers.parseUnits('2000', 6)).then(t => t.wait()));
    console.log('  ✓ funded');

    // Register borrower + create pool
    console.log('\n[2] Register borrower + create pool + approvals');
    const regB = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, borrower);
    await rT(() => regB.register('ipfs://w1-live-' + Date.now(), []).then(t => t.wait()));
    const aid = Number(await rT(() => reg.addressToAgentId(borrower.address)));
    console.log('  borrower agentId=' + aid);
    const v6B = new ethers.Contract(V6, ABI, borrower);
    const usdcB = new ethers.Contract(ADDR.usdc, USDC_ABI, borrower);
    await rT(() => v6B.createAgentPool().then(t => t.wait()));
    await rT(() => usdcB.approve(V6, ethers.MaxUint256).then(t => t.wait()));
    const v6L = new ethers.Contract(V6, ABI, legit);
    const usdcL = new ethers.Contract(ADDR.usdc, USDC_ABI, legit);
    await rT(() => usdcL.approve(V6, ethers.MaxUint256).then(t => t.wait()));
    const v6A = new ethers.Contract(V6, ABI, attacker);
    const usdcA = new ethers.Contract(ADDR.usdc, USDC_ABI, attacker);
    await rT(() => usdcA.approve(V6, ethers.MaxUint256).then(t => t.wait()));

    // Step 1: legit supplies BEFORE loan
    console.log('\n[3] Legit supplies 100 USDC at t0');
    await rT(() => v6L.supplyLiquidity(aid, ethers.parseUnits('100', 6)).then(t => t.wait()));
    const legitPosAtSupply = await v6.positions(aid, legit.address);
    console.log('  legit.depositTimestamp:', legitPosAtSupply.depositTimestamp.toString());

    await sleep(3000);

    // Step 2: borrower requests loan
    console.log('\n[4] Borrower requests 10 USDC loan at t1 (after legit supply)');
    const t1 = await rT(() => v6B.requestLoan(ethers.parseUnits('10', 6), 7));
    const r1 = await rT(() => t1.wait());
    let loanId;
    for (const log of r1.logs) {
        try { const p = v6B.interface.parseLog(log); if (p && p.name === 'LoanRequested') loanId = p.args.loanId; } catch(e) {}
    }
    console.log('  loanId:', loanId.toString());
    const loan = await v6.loans(loanId);
    console.log('  loan.startTime:', loan.startTime.toString());

    await sleep(3000);

    // Step 3: attacker sandwich-supplies after loan starts
    console.log('\n[5] Attacker sandwich-supplies 1000 USDC at t2 (AFTER loan start)');
    await rT(() => v6A.supplyLiquidity(aid, ethers.parseUnits('1000', 6)).then(t => t.wait()));
    const attackerPos = await v6.positions(aid, attacker.address);
    console.log('  attacker.depositTimestamp:', attackerPos.depositTimestamp.toString());
    console.log('  loan.startTime <= attacker.depositTimestamp:', loan.startTime <= attackerPos.depositTimestamp, '(if true, attacker DOES NOT qualify)');

    await sleep(3000);

    // Step 4: borrower repays — distribution happens
    console.log('\n[6] Borrower repays — _distributeInterest runs');
    await rT(() => v6B.repayLoan(loanId).then(t => t.wait()));

    await sleep(3000);

    // Step 5: verify
    console.log('\n[7] Verify interest distribution');
    const legitFinal = await v6.positions(aid, legit.address);
    const attackerFinal = await v6.positions(aid, attacker.address);
    console.log('  legit earnedInterest:', ethers.formatUnits(legitFinal.earnedInterest, 6), 'USDC');
    console.log('  attacker earnedInterest:', ethers.formatUnits(attackerFinal.earnedInterest, 6), 'USDC');

    const pass = legitFinal.earnedInterest > 0n && attackerFinal.earnedInterest === 0n;
    console.log(`\n${pass ? '✅ W1 DEFENSE LIVE-VERIFIED on Arc V6' : '❌ Sandwich attack succeeded — fix not working'}`);
    console.log(`   legit got interest (> 0): ${legitFinal.earnedInterest > 0n}`);
    console.log(`   attacker got NOTHING (=0): ${attackerFinal.earnedInterest === 0n}`);

    // Cleanup
    console.log('\n[8] Cleanup');
    try {
        const lp = await v6.positions(aid, legit.address);
        if (lp.amount > 0n) await rT(() => v6L.withdrawLiquidity(aid, lp.amount).then(t => t.wait()));
    } catch (e) {}
    try {
        const ap = await v6.positions(aid, attacker.address);
        if (ap.amount > 0n) await rT(() => v6A.withdrawLiquidity(aid, ap.amount).then(t => t.wait()));
    } catch (e) {}
    for (const w of [legit, borrower, attacker]) {
        try {
            const u = new ethers.Contract(ADDR.usdc, USDC_ABI, w);
            const b = await usdc.balanceOf(w.address);
            if (b > 0n) await (await u.transfer(owner.address, b)).wait();
        } catch (e) {}
    }
    console.log('  ✓ cleanup done');

    fs.writeFileSync('./forensics/output/regression-2026-05-07/90-w1-sandwich-live.json', JSON.stringify({
        timestamp: new Date().toISOString(), v6: V6, agentId: aid, loanStartTime: loan.startTime.toString(),
        legitDepositTimestamp: legitPosAtSupply.depositTimestamp.toString(),
        attackerDepositTimestamp: attackerPos.depositTimestamp.toString(),
        legitEarnedInterest: legitFinal.earnedInterest.toString(),
        attackerEarnedInterest: attackerFinal.earnedInterest.toString(),
        passed: pass
    }, null, 2));
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
