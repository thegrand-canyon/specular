#!/usr/bin/env node

// Webhook Test Script for Specular Monitor Alerts
// Tests Slack/Discord webhook integration with sample alerts

const WEBHOOK_URL = process.env.WEBHOOK_URL;
if (!WEBHOOK_URL) {
    console.error('WEBHOOK_URL environment variable required');
    console.error('Example: WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/HERE node webhook-test.js');
    process.exit(1);
}

async function sendTestAlert(severity, title, details) {
    const colors = {
        CRITICAL: 'danger',
        WARNING: '#ff9900',
        INFO: 'good'
    };

    const payload = {
        text: `🧪 **TEST ALERT** - Specular Monitor [${severity}]`,
        attachments: [{
            color: colors[severity] || '#666666',
            title: `TEST: ${title}`,
            text: typeof details === 'string' ? details : JSON.stringify(details, null, 2),
            ts: Math.floor(Date.now() / 1000),
            footer: 'Specular Invariant Monitor - Test Mode'
        }]
    };

    try {
        const fetch = (await import('node-fetch')).default;
        const response = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            console.log(`✅ ${severity} alert sent successfully`);
        } else {
            console.log(`❌ ${severity} alert failed: HTTP ${response.status}`);
        }
    } catch (e) {
        console.log(`❌ ${severity} alert error: ${e.message}`);
    }
}

async function runTests() {
    console.log('🧪 Testing Specular Monitor Webhook Integration');
    console.log(`📡 Target: ${WEBHOOK_URL.replace(/\/[^/]+$/, '/***')}`);
    console.log('');

    // Test 1: Critical B1 violation
    await sendTestAlert('CRITICAL', 'B1 Duplicate Lenders Detected', {
        network: 'base-canonical',
        agentId: 1,
        violations: [{
            poolLendersLength: 2,
            duplicates: [{ address: '0x800e305A0caDdE6289dFDFEDF38218f45C06F72C', count: 2 }],
            totalLiquidity: '1.500000'
        }]
    });

    await new Promise(resolve => setTimeout(resolve, 1000));

    // Test 2: Critical S1 violation
    await sendTestAlert('CRITICAL', 'S1 Fund Drain Detected', {
        network: 'base-canonical',
        actualBalance: '1.500000',
        claimedTotal: '1.500002',
        deficit: '0.000002',
        description: 'Pool claims exceed actual USDC holdings'
    });

    await new Promise(resolve => setTimeout(resolve, 1000));

    // Test 3: Warning S5 approaching threshold
    await sendTestAlert('WARNING', 'S5 DoS Threshold Approaching', {
        network: 'arc-testnet',
        agentId: 45,
        lifetimeLoans: 5200,
        threshold: 6500,
        utilizationPercent: '80.0'
    });

    await new Promise(resolve => setTimeout(resolve, 1000));

    // Test 4: Info monitor startup
    await sendTestAlert('INFO', 'Monitor Started Successfully', {
        networks: ['base-canonical', 'base-stale', 'arc-testnet'],
        pollIntervalSec: 300,
        version: '1.0.0'
    });

    console.log('');
    console.log('✅ Webhook test sequence complete');
    console.log('📱 Check your Slack/Discord channel for 4 test messages');
}

runTests().catch(e => {
    console.error('Test failed:', e);
    process.exit(1);
});