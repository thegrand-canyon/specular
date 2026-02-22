/**
 * Repay All Active Loans on Arc Testnet
 */

const { ethers } = require('ethers');
const fs = require('fs');

const RPC_URL = 'https://arc-testnet.drpc.org';
const AGENT_KEY = process.env.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000';

async function main() {
    console.log('\n📋 REPAY ACTIVE LOANS - ARC TESTNET\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const agent = new ethers.Wallet(AGENT_KEY, provider);

    console.log(`Agent: ${agent.address}\n`);

    const addresses = JSON.parse(
        fs.readFileSync('./src/config/arc-testnet-addresses.json', 'utf8')
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

    const marketplaceAbi = loadAbi('AgentLiquidityMarketplace');
    const marketplace = new ethers.Contract(addresses.agentLiquidityMarketplace, marketplaceAbi, agent);

    const states = ['REQUESTED', 'ACTIVE', 'REPAID', 'DEFAULTED'];
    const activeLoans = [];

    // Find all active loans
    console.log('Searching for active loans...\n');

    for (let i = 1; i <= 30; i++) {
        try {
            const loan = await marketplace.loans(i);
            if (loan.borrower.toLowerCase() === agent.address.toLowerCase() && loan.state === 1) {
                activeLoans.push({ id: i, amount: ethers.formatUnits(loan.amount, 6) });
                console.log(`Found active Loan #${i}: ${ethers.formatUnits(loan.amount, 6)} USDC`);
            }
        } catch (e) {
            break;
        }
    }

    if (activeLoans.length === 0) {
        console.log('✅ No active loans found!\n');
        return;
    }

    console.log(`\nFound ${activeLoans.length} active loan(s)\n`);

    // Repay each loan
    for (const loan of activeLoans) {
        console.log(`\nRepaying Loan #${loan.id} (${loan.amount} USDC)...`);

        try {
            const nonce = await provider.getTransactionCount(agent.address);
            const tx = await marketplace.repayLoan(loan.id, { nonce });
            console.log(`Tx: ${tx.hash}`);

            const receipt = await tx.wait();
            console.log(`✅ Repaid! Gas used: ${receipt.gasUsed.toString()}`);

        } catch (error) {
            console.log(`❌ Failed: ${error.message}`);
        }
    }

    console.log('\n✅ All active loans processed!\n');
}

main().catch(console.error);
