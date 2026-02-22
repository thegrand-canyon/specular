/**
 * Debug Loan Request
 *
 * Single loan request with detailed error information
 */

const { ethers } = require('ethers');
const fs = require('fs');

const RPC_URL = 'https://sepolia.base.org';
const AGENT_KEY = process.env.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000';
const LOAN_AMOUNT = '100'; // 100 USDC
const DURATION_DAYS = 7;

async function main() {
    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const agent = new ethers.Wallet(AGENT_KEY, provider);

    console.log(`\n📋 DEBUG LOAN REQUEST\n`);
    console.log(`Agent: ${agent.address}`);
    console.log(`Requesting: ${LOAN_AMOUNT} USDC for ${DURATION_DAYS} days\n`);

    const addresses = JSON.parse(
        fs.readFileSync('./src/config/base-sepolia-addresses.json', 'utf8')
    );

    function loadAbi(name) {
        const paths = [
            `./artifacts/contracts/${name}.sol/${name}.json`,
            `./artifacts/contracts/core/${name}.sol/${name}.json`,
            `./artifacts/contracts/tokens/${name}.sol/${name}.json`,
        ];
        for (const p of paths) {
            try {
                return JSON.parse(fs.readFileSync(p, 'utf8')).abi;
            } catch {}
        }
        throw new Error(`Cannot find ABI for ${name}`);
    }

    const registryAbi = loadAbi('AgentRegistryV2');
    const reputationAbi = loadAbi('ReputationManagerV3');
    const marketplaceAbi = loadAbi('AgentLiquidityMarketplace');
    const usdcAbi = loadAbi('MockUSDC');

    const registry = new ethers.Contract(addresses.AgentRegistryV2, registryAbi, provider);
    const reputation = new ethers.Contract(addresses.ReputationManagerV3, reputationAbi, provider);
    const marketplace = new ethers.Contract(addresses.AgentLiquidityMarketplace, marketplaceAbi, agent);
    const usdc = new ethers.Contract(addresses.MockUSDC, usdcAbi, agent);

    // Check current state
    console.log('═'.repeat(70));
    console.log('CURRENT STATE');
    console.log('═'.repeat(70) + '\n');

    const agentId = await registry.addressToAgentId(agent.address);
    const score = await reputation['getReputationScore(address)'](agent.address);
    const creditLimit = await reputation.calculateCreditLimit(agent.address);
    const interestRate = await reputation.calculateInterestRate(agent.address);
    const usdcBalance = await usdc.balanceOf(agent.address);
    const pool = await marketplace.getAgentPool(agentId);

    console.log(`Agent ID: ${agentId}`);
    console.log(`Reputation Score: ${score}`);
    console.log(`Credit Limit: ${ethers.formatUnits(creditLimit, 6)} USDC`);
    console.log(`Interest Rate: ${Number(interestRate) / 100}% APR`);
    console.log(`USDC Balance: ${ethers.formatUnits(usdcBalance, 6)} USDC\n`);

    console.log('Pool State:');
    console.log(`  Available Liquidity: ${ethers.formatUnits(pool.availableLiquidity, 6)} USDC`);
    console.log(`  Total Loaned: ${ethers.formatUnits(pool.totalLoaned, 6)} USDC\n`);

    // Check what collateral would be required
    const loanAmountWei = ethers.parseUnits(LOAN_AMOUNT, 6);
    console.log('Loan Parameters:');
    console.log(`  Amount: ${LOAN_AMOUNT} USDC`);
    console.log(`  Duration: ${DURATION_DAYS} days`);
    console.log(`  Amount (wei): ${loanAmountWei.toString()}\n`);

    // Try to estimate collateral by checking calculateCollateralRequirement if it exists
    try {
        const collateral = await marketplace.calculateCollateralRequirement(loanAmountWei);
        console.log(`  Required Collateral: ${ethers.formatUnits(collateral, 6)} USDC\n`);
    } catch (e) {
        console.log('  (Cannot calculate collateral - function may not exist)\n');
    }

    // Approve USDC first
    console.log('═'.repeat(70));
    console.log('STEP 1: APPROVE USDC');
    console.log('═'.repeat(70) + '\n');

    const currentAllowance = await usdc.allowance(agent.address, addresses.AgentLiquidityMarketplace);
    console.log(`Current allowance: ${ethers.formatUnits(currentAllowance, 6)} USDC`);

    if (Number(currentAllowance) < Number(loanAmountWei) * 2) {
        console.log('Approving USDC...\n');
        const nonce1 = await provider.getTransactionCount(agent.address);
        const approveTx = await usdc.approve(
            addresses.AgentLiquidityMarketplace,
            ethers.parseUnits('10000', 6),
            { nonce: nonce1 }
        );
        await approveTx.wait();
        console.log('✅ USDC approved\n');
    } else {
        console.log('✅ Already approved\n');
    }

    // Request loan
    console.log('═'.repeat(70));
    console.log('STEP 2: REQUEST LOAN');
    console.log('═'.repeat(70) + '\n');

    try {
        // Try to call statically first to see if it would revert
        console.log('Testing loan request (static call)...\n');
        await marketplace.requestLoan.staticCall(loanAmountWei, DURATION_DAYS);
        console.log('✅ Static call succeeded - proceeding with actual transaction...\n');

        const nonce2 = await provider.getTransactionCount(agent.address);
        const tx = await marketplace.requestLoan(loanAmountWei, DURATION_DAYS, { nonce: nonce2 });

        console.log(`Tx hash: ${tx.hash}`);
        console.log('Waiting for confirmation...\n');

        const receipt = await tx.wait();

        // Extract loan ID
        let loanId;
        for (const log of receipt.logs) {
            try {
                const parsed = marketplace.interface.parseLog(log);
                if (parsed && parsed.name === 'LoanRequested') {
                    loanId = Number(parsed.args.loanId);
                    console.log(`✅ LOAN APPROVED!`);
                    console.log(`Loan ID: ${loanId}\n`);
                    break;
                }
            } catch {}
        }

        if (!loanId) {
            console.log('⚠️  Transaction succeeded but no LoanRequested event found\n');
        }

    } catch (error) {
        console.log('❌ LOAN REQUEST FAILED\n');
        console.log('Error details:');
        console.log(`  Message: ${error.message}`);

        if (error.data) {
            console.log(`  Data: ${error.data}`);
        }

        if (error.error) {
            console.log(`  Error object: ${JSON.stringify(error.error, null, 2)}`);
        }

        console.log('');
    }
}

main().catch(console.error);
