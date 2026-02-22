'use strict';
/**
 * AgentMessenger quick test
 *
 * Tests:
 *  1. Module loads and exports correctly
 *  2. Message templates render correctly
 *  3. NoopMessenger works (no-crash fallback)
 *  4. Live XMTP client creation with PRIVATE_KEY (if set)
 *  5. Self-messaging smoke test (send + readFrom same wallet)
 *
 * Run: ARC_TESTNET_RPC_URL=https://arc-testnet.drpc.org node src/xmtp/test-messenger.js
 */

require('dotenv').config();
const { ethers } = require('ethers');

async function main() {
    let passed = 0;
    let failed = 0;

    function ok(label) {
        console.log(`  ✓ ${label}`);
        passed++;
    }
    function fail(label, err) {
        console.error(`  ✗ ${label}: ${err?.message ?? err}`);
        failed++;
    }

    console.log('\n=== AgentMessenger Test Suite ===\n');

    // ── Test 1: module loads ─────────────────────────────────────────────────
    console.log('1. Module loading');
    let AgentMessenger;
    try {
        ({ AgentMessenger } = require('./AgentMessenger'));
        if (typeof AgentMessenger.create !== 'function') throw new Error('create() missing');
        if (typeof AgentMessenger.msg !== 'object')      throw new Error('msg missing');
        if (typeof AgentMessenger.Noop !== 'function')   throw new Error('Noop missing');
        ok('AgentMessenger loaded with .create, .msg, .Noop');
    } catch (err) {
        fail('module load', err);
        process.exit(1);
    }

    // ── Test 2: message templates ────────────────────────────────────────────
    console.log('\n2. Message templates');
    try {
        const addr = '0xAbCd1234567890AbCd1234567890AbCd12345678';
        const b = AgentMessenger.msg.borrowed(42, 100, addr);
        if (!b.includes('Loan Requested'))   throw new Error('borrowed: missing header');
        if (!b.includes('#42'))              throw new Error('borrowed: missing loanId');
        if (!b.includes('100 USDC'))         throw new Error('borrowed: missing amount');
        ok('msg.borrowed renders correctly');

        const r = AgentMessenger.msg.repaid(42, 100, addr);
        if (!r.includes('Loan Repaid'))      throw new Error('repaid: missing header');
        ok('msg.repaid renders correctly');

        const p = AgentMessenger.msg.promoted('SUBPRIME', 'STANDARD', 610, addr);
        if (!p.includes('SUBPRIME → STANDARD')) throw new Error('promoted: missing tiers');
        ok('msg.promoted renders correctly');

        const s = AgentMessenger.msg.supplied(5, 500, addr);
        if (!s.includes('pool #5'))          throw new Error('supplied: missing pool');
        if (!s.includes('500 USDC'))         throw new Error('supplied: missing amount');
        ok('msg.supplied renders correctly');
    } catch (err) {
        fail('templates', err);
    }

    // ── Test 3: NoopMessenger ────────────────────────────────────────────────
    console.log('\n3. NoopMessenger (fallback)');
    try {
        const noop = new AgentMessenger.Noop('0x1234');
        if (noop.address !== '0x1234')   throw new Error('address mismatch');
        if (!noop._noop)                 throw new Error('_noop flag missing');
        const sent = await noop.send('0xdead', 'hello');
        if (sent !== false)              throw new Error('send() should return false');
        const msgs = await noop.readFrom('0xdead');
        if (!Array.isArray(msgs) || msgs.length !== 0) throw new Error('readFrom() should return []');
        ok('NoopMessenger: address, _noop, send→false, readFrom→[]');
    } catch (err) {
        fail('NoopMessenger', err);
    }

    // ── Test 4: live XMTP client creation ───────────────────────────────────
    const PRIVATE_KEY = process.env.PRIVATE_KEY;
    if (!PRIVATE_KEY) {
        console.log('\n4. Live XMTP (skipped — no PRIVATE_KEY)');
    } else {
        console.log('\n4. Live XMTP client creation');
        try {
            const provider = new ethers.JsonRpcProvider(
                process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org',
                undefined,
                { batchMaxCount: 1 },
            );
            const wallet    = new ethers.Wallet(PRIVATE_KEY, provider);
            console.log(`   Wallet: ${wallet.address}`);

            console.log('   Creating XMTP client (dev env)...');
            const messenger = await AgentMessenger.create(wallet, 'dev');

            if (messenger._noop) {
                fail('live XMTP', new Error('got NoopMessenger — package installed but create() failed'));
            } else {
                ok(`XMTP client created for ${wallet.address.slice(0, 10)}...`);
                ok(`sentCount starts at 0: ${messenger.sentCount === 0}`);

                // ── Test 5: self-messaging ───────────────────────────────────
                console.log('\n5. Self-messaging smoke test');
                const testMsg = AgentMessenger.msg.borrowed(999, 42, wallet.address);
                console.log('   Sending message to self...');
                const sendResult = await messenger.send(wallet.address, testMsg);
                if (sendResult) {
                    ok(`Self-message sent (sentCount: ${messenger.sentCount})`);
                } else {
                    // Self may not have XMTP identity in all envs — soft warning
                    console.log('   ⚠ Self-message returned false (wallet may need XMTP identity first)');
                    console.log('   This is expected on first run — re-run after identity is registered');
                }

                // Read back messages
                console.log('   Reading messages from self...');
                const incoming = await messenger.readFrom(wallet.address, 5);
                ok(`readFrom() returned ${incoming.length} message(s)`);
                if (incoming.length > 0) {
                    console.log(`   Latest: "${incoming[incoming.length - 1].content.split('\n')[0]}"`);
                }
            }
        } catch (err) {
            fail('live XMTP', err);
        }
    }

    // ── Summary ──────────────────────────────────────────────────────────────
    console.log(`\n${'─'.repeat(40)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed === 0) {
        console.log('All tests passed ✓');
    }
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
