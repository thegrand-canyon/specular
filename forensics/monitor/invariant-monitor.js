#!/usr/bin/env node

// Specular Marketplace Invariant Monitor
//
// Purpose: Continuous monitoring daemon for the three critical invariant violations:
//   §S1: Σ claimed liabilities vs actual USDC balance
//   §B1: Duplicate addresses in poolLenders[] arrays
//   §S5: Agent lifetime loan counts approaching DoS thresholds
//
// Safety: READ-ONLY MONITORING. No state mutations, no transactions sent.
//         Uses view calls (eth_call) and event log queries only.
//
// Usage:
//   BASE_RPC_URL=https://mainnet.base.org \
//   ARC_TESTNET_RPC_URL=https://arc-testnet.drpc.org \
//   POLL_INTERVAL_SEC=60 \
//   WEBHOOK_URL=https://hooks.slack.com/... \
//   node invariant-monitor.js
//
// Output: JSON structured logs to stdout; optionally POSTs alerts to webhook

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const LOG_LEVEL = process.env.LOG_LEVEL || 'INFO'; // DEBUG, INFO, WARN, ERROR
const POLL_INTERVAL_SEC = parseInt(process.env.POLL_INTERVAL_SEC || '60', 10);
const WEBHOOK_URL = process.env.WEBHOOK_URL;

const BASE_RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const ARC_RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';

const ROOT = path.resolve(__dirname, '..', '..');
const BASE_ADDR = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/config/base-addresses.json')));
const ARC_ADDR = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/config/arc-testnet-addresses.json')));
const MP_ABI = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json'))).abi;
const REG_ABI = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json'))).abi;

// Network configurations
const NETWORKS = [
    {
        name: 'base-canonical',
        rpc: BASE_RPC,
        marketplace: '0xd7b4dEE74C61844DFA75aEbe224e4635463b1C8f',
        registry: BASE_ADDR.agentRegistryV2,
        usdc: BASE_ADDR.usdc,
        gasLimit: 30_000_000,
        s5Threshold: 6441 // empirical Base brick threshold
    },
    {
        name: 'base-stale',
        rpc: BASE_RPC,
        marketplace: '0x77F8D49cdE6Ae7481BeA38C8a70b5A893bD4d9AF',
        registry: BASE_ADDR.agentRegistryV2,
        usdc: BASE_ADDR.usdc,
        gasLimit: 30_000_000,
        s5Threshold: 6441
    },
    {
        name: 'arc-testnet',
        rpc: ARC_RPC,
        marketplace: ARC_ADDR.agentLiquidityMarketplace,
        registry: ARC_ADDR.agentRegistryV2,
        usdc: ARC_ADDR.mockUSDC,
        gasLimit: 32_000_000,
        s5Threshold: 6876 // empirical Arc brick threshold
    }
];

function log(level, message, data = {}) {
    const levels = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
    if (levels[level] < levels[LOG_LEVEL]) return;

    const entry = {
        timestamp: new Date().toISOString(),
        level,
        message,
        ...data
    };
    console.log(JSON.stringify(entry));
}

async function sendAlert(severity, title, details) {
    if (!WEBHOOK_URL) return;

    const payload = {
        text: `🚨 Specular Invariant Violation [${severity}]`,
        attachments: [{
            color: severity === 'CRITICAL' ? 'danger' : 'warning',
            title,
            text: JSON.stringify(details, null, 2),
            ts: Math.floor(Date.now() / 1000)
        }]
    };

    try {
        const fetch = (await import('node-fetch')).default;
        const response = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            log('ERROR', 'Webhook delivery failed', { status: response.status });
        }
    } catch (e) {
        log('ERROR', 'Webhook error', { error: e.message });
    }
}

async function checkInvariantS1(network, contracts) {
    try {
        const { mp, reg, usdc } = contracts;
        const totalAgents = Number(await reg.totalAgents());
        let totalClaimed = 0n;
        let totalEarnedInterest = 0n;
        let accumulatedFees = 0n;

        log('DEBUG', 'Checking S1 invariant', { network: network.name, totalAgents });

        for (let aid = 1; aid <= totalAgents; aid++) {
            try {
                const pool = await mp.getAgentPool(aid);
                const isActive = pool[6];
                if (!isActive) continue;

                const totalLiquidity = pool[2];
                const availableLiquidity = pool[3];
                const totalLoaned = pool[4];
                const totalEarned = pool[5];

                totalClaimed += totalLiquidity + totalEarned;

                // Sum position.earnedInterest across all lenders
                const lenders = [];
                let i = 0;
                while (true) {
                    try {
                        const lender = await mp.poolLenders(aid, i);
                        lenders.push(lender);
                        i++;
                    } catch {
                        break;
                    }
                }

                for (const lender of lenders) {
                    try {
                        const pos = await mp.positions(aid, lender);
                        totalEarnedInterest += pos[1];
                    } catch {}
                }

            } catch (e) {
                log('DEBUG', 'Pool read error', { aid, error: e.message });
            }
        }

        try {
            accumulatedFees = await mp.accumulatedFees();
        } catch {}

        const actualBalance = await usdc.balanceOf(network.marketplace);
        const claimedTotal = totalClaimed + totalEarnedInterest + accumulatedFees;
        const deficit = claimedTotal - actualBalance;

        const result = {
            network: network.name,
            actualBalance: ethers.formatUnits(actualBalance, 6),
            claimedTotal: ethers.formatUnits(claimedTotal, 6),
            breakdown: {
                totalLiquidity: ethers.formatUnits(totalClaimed, 6),
                earnedInterest: ethers.formatUnits(totalEarnedInterest, 6),
                accumulatedFees: ethers.formatUnits(accumulatedFees, 6)
            },
            deficit: ethers.formatUnits(deficit, 6),
            violatesS1: deficit > 0n
        };

        if (result.violatesS1) {
            log('ERROR', 'S1 invariant violation detected', result);
            await sendAlert('CRITICAL', `S1 Fund Drain on ${network.name}`, result);
        } else {
            log('INFO', 'S1 invariant healthy', result);
        }

        return result;

    } catch (e) {
        log('ERROR', 'S1 check failed', { network: network.name, error: e.message });
        return null;
    }
}

async function checkInvariantB1(network, contracts) {
    try {
        const { mp, reg } = contracts;
        const totalAgents = Number(await reg.totalAgents());
        const violations = [];

        log('DEBUG', 'Checking B1 invariant', { network: network.name, totalAgents });

        for (let aid = 1; aid <= totalAgents; aid++) {
            try {
                const pool = await mp.getAgentPool(aid);
                if (!pool[6]) continue; // skip inactive pools

                const lenders = [];
                const counts = new Map();
                let i = 0;
                while (true) {
                    try {
                        const lender = await mp.poolLenders(aid, i);
                        lenders.push(lender);
                        const key = lender.toLowerCase();
                        counts.set(key, (counts.get(key) || 0) + 1);
                        i++;
                    } catch {
                        break;
                    }
                }

                const duplicates = [...counts.entries()].filter(([_, n]) => n > 1);
                if (duplicates.length > 0) {
                    const violation = {
                        agentId: aid,
                        poolLendersLength: lenders.length,
                        duplicates: duplicates.map(([addr, count]) => ({ address: addr, count })),
                        totalLiquidity: ethers.formatUnits(pool[2], 6)
                    };
                    violations.push(violation);
                }

            } catch (e) {
                log('DEBUG', 'Pool B1 check error', { aid, error: e.message });
            }
        }

        const result = {
            network: network.name,
            violations,
            violatesB1: violations.length > 0
        };

        if (result.violatesB1) {
            log('ERROR', 'B1 invariant violation detected', result);
            await sendAlert('CRITICAL', `B1 Duplicate Lenders on ${network.name}`, result);
        } else {
            log('INFO', 'B1 invariant healthy', result);
        }

        return result;

    } catch (e) {
        log('ERROR', 'B1 check failed', { network: network.name, error: e.message });
        return null;
    }
}

async function checkInvariantS5(network, contracts) {
    try {
        const { mp, reg } = contracts;
        const totalAgents = Number(await reg.totalAgents());
        const warnings = [];

        log('DEBUG', 'Checking S5 invariant', { network: network.name, totalAgents });

        for (let aid = 1; aid <= totalAgents; aid++) {
            try {
                const pool = await mp.getAgentPool(aid);
                if (!pool[6]) continue;

                const agentAddr = pool[1];

                // Binary search to find agentLoans length efficiently
                let low = 0, high = 10000;
                while (low <= high) {
                    const mid = Math.floor((low + high) / 2);
                    try {
                        await mp.agentLoans(agentAddr, mid);
                        low = mid + 1;
                    } catch {
                        high = mid - 1;
                    }
                }
                const lifetimeLoans = low;

                // Estimate gas cost using empirical formula: gas ≈ 4600 × N + 366000
                const estimatedGas = 4600 * lifetimeLoans + 366000;
                const warningThreshold = network.s5Threshold * 0.8; // 80% of brick threshold

                if (lifetimeLoans > warningThreshold) {
                    warnings.push({
                        agentId: aid,
                        agentAddress: agentAddr,
                        lifetimeLoans,
                        estimatedGas,
                        gasLimit: network.gasLimit,
                        utilizationPercent: (estimatedGas / network.gasLimit * 100).toFixed(1)
                    });
                }

            } catch (e) {
                log('DEBUG', 'Agent S5 check error', { aid, error: e.message });
            }
        }

        const critical = warnings.filter(w => w.lifetimeLoans > network.s5Threshold);
        const result = {
            network: network.name,
            warnings,
            critical,
            violatesS5: critical.length > 0
        };

        if (result.violatesS5) {
            log('ERROR', 'S5 invariant violation detected', result);
            await sendAlert('CRITICAL', `S5 DoS Threshold Reached on ${network.name}`, result);
        } else if (warnings.length > 0) {
            log('WARN', 'S5 warning levels detected', result);
            await sendAlert('WARNING', `S5 DoS Warning on ${network.name}`, result);
        } else {
            log('INFO', 'S5 invariant healthy', { network: network.name });
        }

        return result;

    } catch (e) {
        log('ERROR', 'S5 check failed', { network: network.name, error: e.message });
        return null;
    }
}

async function monitorNetwork(network) {
    try {
        log('INFO', 'Starting network scan', { network: network.name });

        const provider = new ethers.JsonRpcProvider(network.rpc, undefined, { batchMaxCount: 1 });
        const mp = new ethers.Contract(network.marketplace, MP_ABI, provider);
        const reg = new ethers.Contract(network.registry, REG_ABI, provider);
        const usdc = new ethers.Contract(network.usdc, [
            'function balanceOf(address) view returns (uint256)'
        ], provider);

        const contracts = { mp, reg, usdc };
        const block = await provider.getBlock('latest');

        // Run all invariant checks in parallel
        const [s1Result, b1Result, s5Result] = await Promise.all([
            checkInvariantS1(network, contracts),
            checkInvariantB1(network, contracts),
            checkInvariantS5(network, contracts)
        ]);

        const summary = {
            network: network.name,
            blockNumber: block.number,
            timestamp: block.timestamp,
            results: {
                s1: s1Result ? { violates: s1Result.violatesS1, deficit: s1Result.deficit } : null,
                b1: b1Result ? { violates: b1Result.violatesB1, violations: b1Result.violations.length } : null,
                s5: s5Result ? { violates: s5Result.violatesS5, warnings: s5Result.warnings.length } : null
            }
        };

        log('INFO', 'Network scan complete', summary);
        return summary;

    } catch (e) {
        log('ERROR', 'Network monitor failed', { network: network.name, error: e.message });
        return null;
    }
}

async function main() {
    log('INFO', 'Specular Invariant Monitor starting', {
        networks: NETWORKS.map(n => n.name),
        pollIntervalSec: POLL_INTERVAL_SEC,
        hasWebhook: !!WEBHOOK_URL
    });

    // Main monitoring loop
    while (true) {
        const cycleStart = Date.now();

        log('INFO', 'Starting monitoring cycle');

        // Monitor all networks in parallel
        const results = await Promise.allSettled(
            NETWORKS.map(network => monitorNetwork(network))
        );

        const successful = results.filter(r => r.status === 'fulfilled').length;
        const failed = results.filter(r => r.status === 'rejected').length;

        log('INFO', 'Monitoring cycle complete', {
            duration: Date.now() - cycleStart,
            successful,
            failed
        });

        // Sleep until next cycle
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_SEC * 1000));
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    log('INFO', 'Shutting down invariant monitor');
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('INFO', 'Shutting down invariant monitor');
    process.exit(0);
});

main().catch(e => {
    log('ERROR', 'Monitor crashed', { error: e.message, stack: e.stack });
    process.exit(1);
});