/**
 * Repay All V3 Loans
 * Automatically finds and repays all active loans for the current signer
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    console.log('\n💰 REPAYING ALL V3 LOANS\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const [signer] = await ethers.getSigners();
    console.log('Agent:', signer.address);

    // Load addresses
    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const lendingPool = await ethers.getContractAt('LendingPoolV3', addresses.lendingPool);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    // Find all active loans for this agent
    const nextLoanId = await lendingPool.nextLoanId();
    const activeLoans = [];

    console.log('🔍 Scanning for active loans...\n');

    for (let i = 0; i < nextLoanId; i++) {
        try {
            const loan = await lendingPool.loans(i);

            // Check if loan belongs to signer and is ACTIVE (state = 2)
            if (loan.borrower.toLowerCase() === signer.address.toLowerCase() && Number(loan.state) === 2) {
                activeLoans.push({
                    id: i,
                    amount: loan.amount,
                    interestRate: loan.interestRate,
                    durationDays: loan.durationDays,
                    endTime: loan.endTime
                });
            }
        } catch (error) {
            // Skip if loan doesn't exist
        }
    }

    if (activeLoans.length === 0) {
        console.log('✅ No active loans found!\n');
        return;
    }

    console.log(`Found ${activeLoans.length} active loan(s):\n`);
    console.log('═══════════════════════════════════════════════════════\n');

    let totalPrincipal = 0n;
    let totalInterest = 0n;
    let totalRepaid = 0n;
    let successfulRepayments = 0;

    const startBalance = await usdc.balanceOf(signer.address);
    console.log('Starting Balance:', ethers.formatUnits(startBalance, 6), 'USDC\n');

    for (let i = 0; i < activeLoans.length; i++) {
        const loan = activeLoans[i];

        console.log(`Loan ${i + 1}/${activeLoans.length} - ID: ${loan.id}`);
        console.log('─────────────────────────────────────────');

        // Calculate repayment
        const principal = loan.amount;
        const rate = loan.interestRate;
        const duration = loan.durationDays;
        const interest = (principal * rate * duration) / (10000n * 365n);
        const totalRepayment = principal + interest;

        console.log('Amount:', ethers.formatUnits(principal, 6), 'USDC');
        console.log('Interest Rate:', (Number(rate) / 100).toFixed(2), '% APR');
        console.log('Duration:', duration.toString(), 'days');
        console.log('Interest:', ethers.formatUnits(interest, 6), 'USDC');
        console.log('Total Repayment:', ethers.formatUnits(totalRepayment, 6), 'USDC');

        try {
            // Approve USDC
            console.log('\n⏳ Approving USDC...');
            const approveTx = await usdc.approve(addresses.lendingPool, totalRepayment);
            await approveTx.wait();

            // Repay loan
            console.log('⏳ Repaying loan...');
            const repayTx = await lendingPool.repayLoan(loan.id);
            const receipt = await repayTx.wait();

            // Check if repaid on time
            const event = receipt.logs.find(log => {
                try {
                    return lendingPool.interface.parseLog(log)?.name === 'LoanRepaid';
                } catch { return false; }
            });

            if (event) {
                const parsed = lendingPool.interface.parseLog(event);
                const onTime = parsed.args.onTime;

                console.log('✅ REPAID!');
                console.log('On Time:', onTime ? '✅ YES' : '❌ NO');

                totalPrincipal += principal;
                totalInterest += interest;
                totalRepaid += totalRepayment;
                successfulRepayments++;
            }

        } catch (error) {
            console.log('❌ Error:', error.message.split('\n')[0]);
        }

        console.log('');

        // Delay between repayments
        if (i < activeLoans.length - 1) {
            await sleep(5000);
        }
    }

    const endBalance = await usdc.balanceOf(signer.address);
    const poolLiquidity = await lendingPool.availableLiquidity();
    const totalLoaned = await lendingPool.totalLoaned();

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📊 Repayment Summary:\n');
    console.log('Total Loans Repaid:', successfulRepayments, '/', activeLoans.length);
    console.log('Total Principal:', ethers.formatUnits(totalPrincipal, 6), 'USDC');
    console.log('Total Interest Paid:', ethers.formatUnits(totalInterest, 6), 'USDC');
    console.log('Total Repaid:', ethers.formatUnits(totalRepaid, 6), 'USDC');
    console.log('Success Rate:', ((successfulRepayments / activeLoans.length) * 100).toFixed(1) + '%');

    console.log('\n📊 Final Balances:');
    console.log('───────────────────────────────────────────────────────');
    console.log('Agent Balance:', ethers.formatUnits(endBalance, 6), 'USDC');
    console.log('Balance Change:', ethers.formatUnits(endBalance - startBalance, 6), 'USDC');
    console.log('Pool Available Liquidity:', ethers.formatUnits(poolLiquidity, 6), 'USDC');
    console.log('Pool Total Loaned:', ethers.formatUnits(totalLoaned, 6), 'USDC');

    console.log('\n✅ All loans repaid! Pool earned', ethers.formatUnits(totalInterest, 6), 'USDC in fees! 💰\n');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
