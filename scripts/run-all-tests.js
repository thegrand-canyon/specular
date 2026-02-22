/**
 * Run All Test Suites
 * Executes all testing scripts in sequence and generates comprehensive report
 */

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');

const execPromise = util.promisify(exec);

const tests = [
    {
        name: 'Master Test Suite',
        file: 'master-test-suite.js',
        description: 'Core P2P marketplace functionality',
        critical: true
    },
    {
        name: 'Edge Cases',
        file: 'test-edge-cases.js',
        description: 'Boundary conditions and error handling',
        critical: true
    },
    {
        name: 'Multi-Lender',
        file: 'test-multi-lender.js',
        description: 'Proportional interest distribution',
        critical: true
    },
    {
        name: 'Withdrawals',
        file: 'test-withdrawals.js',
        description: 'Lender withdrawal scenarios',
        critical: false
    },
    {
        name: 'Security',
        file: 'test-security.js',
        description: 'Access control and security',
        critical: true
    },
    {
        name: 'Stress Tests',
        file: 'test-stress.js',
        description: 'High volume and concurrent operations',
        critical: false
    },
    {
        name: 'Interest Precision',
        file: 'test-interest-precision.js',
        description: 'Interest calculation accuracy (16 scenarios)',
        critical: true
    },
    {
        name: 'Gas Optimization',
        file: 'test-gas-optimization.js',
        description: 'Gas cost analysis for all operations',
        critical: false
    },
    {
        name: 'Reputation Levels',
        file: 'test-reputation-levels.js',
        description: 'Credit limits at all reputation tiers',
        critical: true
    },
    {
        name: 'Platform Fees',
        file: 'test-platform-fees.js',
        description: 'Fee collection and distribution',
        critical: true
    },
    {
        name: 'Integration Tests',
        file: 'test-integration.js',
        description: 'Complex multi-step workflows',
        critical: true
    }
];

async function runTest(test) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Running: ${test.name}`);
    console.log(`Description: ${test.description}`);
    console.log(`${'='.repeat(60)}\n`);

    const startTime = Date.now();

    try {
        const { stdout, stderr } = await execPromise(
            `npx hardhat run scripts/${test.file} --network sepolia`,
            { maxBuffer: 1024 * 1024 * 10 } // 10MB buffer
        );

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);

        console.log(stdout);
        if (stderr) console.error(stderr);

        return {
            name: test.name,
            file: test.file,
            status: 'PASS',
            duration: duration + 's',
            critical: test.critical
        };

    } catch (error) {
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);

        console.error(`❌ ${test.name} failed:`, error.message);

        return {
            name: test.name,
            file: test.file,
            status: 'FAIL',
            duration: duration + 's',
            critical: test.critical,
            error: error.message
        };
    }
}

async function main() {
    console.log('\n🧪 COMPREHENSIVE TEST SUITE RUNNER\n');
    console.log('═══════════════════════════════════════════════════════\n');
    console.log(`Total Test Suites: ${tests.length}`);
    console.log(`Critical Tests: ${tests.filter(t => t.critical).length}`);
    console.log('');

    const startTime = Date.now();
    const results = [];

    for (const test of tests) {
        const result = await runTest(test);
        results.push(result);

        // Stop if critical test fails
        if (result.critical && result.status === 'FAIL') {
            console.log('\n🚨 CRITICAL TEST FAILED - STOPPING\n');
            break;
        }

        // Small delay between tests
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);

    // Generate summary report
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('📊 COMPREHENSIVE TEST REPORT');
    console.log('═══════════════════════════════════════════════════════\n');

    const passed = results.filter(r => r.status === 'PASS').length;
    const failed = results.filter(r => r.status === 'FAIL').length;
    const criticalFailed = results.filter(r => r.critical && r.status === 'FAIL').length;

    console.log('SUMMARY:');
    console.log(`   Total Suites: ${results.length}/${tests.length}`);
    console.log(`   ✅ Passed:    ${passed}`);
    console.log(`   ❌ Failed:    ${failed}`);
    console.log(`   ⏱️  Duration:  ${totalDuration}s`);
    console.log('');

    console.log('DETAILED RESULTS:\n');
    results.forEach((r, idx) => {
        const icon = r.status === 'PASS' ? '✅' : '❌';
        const critical = r.critical ? '[CRITICAL]' : '';
        console.log(`${idx + 1}. ${icon} ${r.name} ${critical}`);
        console.log(`   File: ${r.file}`);
        console.log(`   Duration: ${r.duration}`);
        if (r.error) {
            console.log(`   Error: ${r.error.substring(0, 100)}...`);
        }
        console.log('');
    });

    // Individual reports
    console.log('INDIVIDUAL REPORTS AVAILABLE:\n');
    const reports = [
        'master-test-report.json',
        'edge-case-test-report.json',
        'multi-lender-test-report.json',
        'withdrawal-test-report.json',
        'security-test-report.json',
        'stress-test-report.json',
        'interest-precision-report.json',
        'gas-optimization-report.json',
        'reputation-levels-report.json',
        'platform-fee-report.json',
        'integration-test-report.json'
    ];

    reports.forEach(report => {
        const reportPath = path.join(__dirname, '..', report);
        if (fs.existsSync(reportPath)) {
            console.log(`   ✅ ${report}`);
        } else {
            console.log(`   ⏭️  ${report} (not generated)`);
        }
    });
    console.log('');

    // Save comprehensive report
    const comprehensiveReport = {
        timestamp: new Date().toISOString(),
        totalDuration: totalDuration + 's',
        summary: {
            total: results.length,
            passed,
            failed,
            criticalFailed,
            successRate: ((passed / results.length) * 100).toFixed(1) + '%'
        },
        results
    };

    const reportPath = path.join(__dirname, '..', 'comprehensive-test-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(comprehensiveReport, null, 2));
    console.log(`📁 Comprehensive report: comprehensive-test-report.json\n`);

    // Final verdict
    console.log('═══════════════════════════════════════════════════════\n');

    if (criticalFailed > 0) {
        console.log('🚨 CRITICAL TESTS FAILED - DO NOT DEPLOY\n');
        console.log('Fix critical issues before proceeding to mainnet.\n');
        process.exit(1);
    } else if (failed > 0) {
        console.log('⚠️  Some tests failed - Review before deployment\n');
        process.exit(1);
    } else {
        console.log('🎉 ALL TESTS PASSED!\n');
        console.log('✅ P2P Marketplace is ready for deployment\n');
        console.log('Next Steps:');
        console.log('1. Deploy to Base Sepolia for final validation');
        console.log('2. Deploy to Base mainnet');
        console.log('3. Expand to other chains\n');
        process.exit(0);
    }
}

main().catch(error => {
    console.error('\n❌ Test runner crashed:', error);
    process.exit(1);
});
