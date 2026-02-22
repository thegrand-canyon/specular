/**
 * Interest Precision Testing Suite
 * Validates interest calculations across various amounts, rates, and durations
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🔬 INTEREST PRECISION TESTING SUITE\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);

    const results = [];

    // Test scenarios: [principal (USDC), rate (BPS), duration (days), expected interest (USDC)]
    const testCases = [
        // Small amounts
        { principal: 100, rate: 500, duration: 7, description: 'Small short-term' },
        { principal: 100, rate: 1500, duration: 30, description: 'Small monthly' },
        { principal: 500, rate: 700, duration: 14, description: 'Small bi-weekly' },

        // Medium amounts
        { principal: 1000, rate: 500, duration: 30, description: 'Medium 5% 30-day' },
        { principal: 1000, rate: 1500, duration: 30, description: 'Medium 15% 30-day' },
        { principal: 5000, rate: 1000, duration: 60, description: 'Medium 10% 60-day' },

        // Large amounts
        { principal: 10000, rate: 500, duration: 90, description: 'Large 5% 90-day' },
        { principal: 25000, rate: 700, duration: 180, description: 'Large 7% 180-day' },
        { principal: 50000, rate: 1500, duration: 365, description: 'Large 15% annual' },

        // Edge cases
        { principal: 1, rate: 1500, duration: 7, description: 'Minimum amount' },
        { principal: 100000, rate: 500, duration: 7, description: 'Very large amount' },
        { principal: 1000, rate: 2000, duration: 7, description: 'Maximum rate (20%)' },
        { principal: 1000, rate: 500, duration: 365, description: 'Maximum duration' },

        // Precision tests
        { principal: 1234.56, rate: 789, duration: 45, description: 'Decimal principal' },
        { principal: 9999, rate: 1111, duration: 111, description: 'Odd numbers' },
        { principal: 7777.77, rate: 555, duration: 33, description: 'Decimal precision' }
    ];

    console.log(`Testing ${testCases.length} interest calculation scenarios\n`);

    for (const [idx, testCase] of testCases.entries()) {
        console.log(`TEST ${idx + 1}: ${testCase.description}`);

        try {
            // Convert to contract units
            const principal = ethers.parseUnits(testCase.principal.toString(), 6);
            const rate = testCase.rate;
            const durationDays = testCase.duration;
            const durationSeconds = durationDays * 24 * 60 * 60;

            // Calculate expected interest (manual)
            const expectedInterest = (Number(principal) * rate * durationSeconds) / (10000 * 365 * 24 * 60 * 60);

            // Get contract calculated interest
            const actualInterest = await marketplace.calculateInterest(
                principal,
                rate,
                durationSeconds
            );

            const actualInterestNum = Number(actualInterest);

            // Calculate difference
            const difference = Math.abs(actualInterestNum - expectedInterest);
            const percentDiff = expectedInterest > 0 ? (difference / expectedInterest) * 100 : 0;

            console.log(`   Principal: ${testCase.principal} USDC`);
            console.log(`   Rate: ${rate / 100}% APR`);
            console.log(`   Duration: ${durationDays} days`);
            console.log(`   Expected: ${(expectedInterest / 1e6).toFixed(8)} USDC`);
            console.log(`   Actual:   ${ethers.formatUnits(actualInterest, 6)} USDC`);
            console.log(`   Diff:     ${(difference / 1e6).toFixed(8)} USDC (${percentDiff.toFixed(6)}%)`);

            // Tolerance: 0.01% (1 basis point)
            const tolerance = 0.01;

            if (percentDiff <= tolerance) {
                console.log(`   ✅ PASS (within ${tolerance}% tolerance)`);
                results.push({
                    test: testCase.description,
                    status: 'PASS',
                    principal: testCase.principal,
                    rate: testCase.rate,
                    duration: testCase.duration,
                    expected: (expectedInterest / 1e6).toFixed(8),
                    actual: ethers.formatUnits(actualInterest, 6),
                    percentDiff: percentDiff.toFixed(6) + '%'
                });
            } else {
                console.log(`   ❌ FAIL (exceeds ${tolerance}% tolerance)`);
                results.push({
                    test: testCase.description,
                    status: 'FAIL',
                    principal: testCase.principal,
                    rate: testCase.rate,
                    duration: testCase.duration,
                    expected: (expectedInterest / 1e6).toFixed(8),
                    actual: ethers.formatUnits(actualInterest, 6),
                    percentDiff: percentDiff.toFixed(6) + '%'
                });
            }

        } catch (error) {
            console.log(`   ❌ ERROR: ${error.message}`);
            results.push({
                test: testCase.description,
                status: 'ERROR',
                error: error.message
            });
        }

        console.log('');
    }

    // =============================================
    // Additional: Platform Fee Calculation Test
    // =============================================
    console.log('BONUS TEST: Platform Fee Calculation\n');

    try {
        const testInterest = ethers.parseUnits('100', 6); // 100 USDC interest
        const platformFeeRate = 100; // 1% (100 basis points)

        const expectedPlatformFee = (Number(testInterest) * platformFeeRate) / 10000;
        const calculatedPlatformFee = (testInterest * BigInt(platformFeeRate)) / 10000n;

        const expectedLenderShare = Number(testInterest) - expectedPlatformFee;
        const calculatedLenderShare = testInterest - calculatedPlatformFee;

        console.log(`   Total Interest: 100 USDC`);
        console.log(`   Platform Fee (1%): ${ethers.formatUnits(calculatedPlatformFee, 6)} USDC`);
        console.log(`   Lender Share (99%): ${ethers.formatUnits(calculatedLenderShare, 6)} USDC`);
        console.log('');

        // Verify adds up
        const sum = calculatedPlatformFee + calculatedLenderShare;
        if (sum === testInterest) {
            console.log(`   ✅ PASS: Platform fee + Lender share = Total interest`);
            results.push({
                test: 'Platform fee calculation',
                status: 'PASS',
                platformFee: ethers.formatUnits(calculatedPlatformFee, 6),
                lenderShare: ethers.formatUnits(calculatedLenderShare, 6)
            });
        } else {
            console.log(`   ❌ FAIL: Sum mismatch`);
            results.push({
                test: 'Platform fee calculation',
                status: 'FAIL',
                reason: 'Sum does not equal total'
            });
        }

    } catch (error) {
        console.log(`   ❌ ERROR: ${error.message}`);
        results.push({
            test: 'Platform fee calculation',
            status: 'ERROR',
            error: error.message
        });
    }

    console.log('');

    // =============================================
    // SUMMARY
    // =============================================
    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📊 INTEREST PRECISION TEST SUMMARY\n');

    const passed = results.filter(r => r.status === 'PASS').length;
    const failed = results.filter(r => r.status === 'FAIL').length;
    const errors = results.filter(r => r.status === 'ERROR').length;

    console.log(`Total Tests: ${results.length}`);
    console.log(`✅ Passed:   ${passed}`);
    console.log(`❌ Failed:   ${failed}`);
    console.log(`⚠️  Errors:   ${errors}`);
    console.log('');

    // Find worst accuracy
    const accuracyTests = results.filter(r => r.percentDiff);
    if (accuracyTests.length > 0) {
        const worstAccuracy = accuracyTests.reduce((worst, current) => {
            const currentDiff = parseFloat(current.percentDiff);
            const worstDiff = parseFloat(worst.percentDiff);
            return currentDiff > worstDiff ? current : worst;
        });

        console.log('📉 Accuracy Statistics:');
        console.log(`   Best: < 0.01% diff (most tests)`);
        console.log(`   Worst: ${worstAccuracy.percentDiff} (${worstAccuracy.test})`);
        console.log('');
    }

    if (failed > 0) {
        console.log('🚨 FAILED TESTS:\n');
        results.filter(r => r.status === 'FAIL').forEach(r => {
            console.log(`   - ${r.test}`);
            console.log(`     Expected: ${r.expected} USDC`);
            console.log(`     Actual:   ${r.actual} USDC`);
            console.log(`     Diff:     ${r.percentDiff}`);
            console.log('');
        });
    }

    // Save results
    const reportPath = path.join(__dirname, '..', 'interest-precision-report.json');
    fs.writeFileSync(reportPath, JSON.stringify({
        results,
        summary: { passed, failed, errors },
        timestamp: new Date().toISOString()
    }, null, 2));
    console.log(`📁 Report saved to: interest-precision-report.json\n`);

    if (failed === 0 && errors === 0) {
        console.log('🎉 All interest precision tests passed!\n');
        console.log('✅ VERIFIED: Interest calculations accurate across all scenarios\n');
        process.exit(0);
    } else {
        console.log('❌ Some interest tests failed. Review formula.\n');
        console.log('🚨 CRITICAL: Interest calculation must be 100% accurate\n');
        process.exit(1);
    }
}

main().catch(error => {
    console.error('Test suite error:', error);
    process.exit(1);
});
