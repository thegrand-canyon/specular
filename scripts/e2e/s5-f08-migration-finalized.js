/**
 * S5 — F-08: on the V6.1 staging marketplace the migration helpers are dead for the OWNER.
 * seedPool / seedPosition / setMigrationFinalized from the owner all revert "Migration finalized".
 * (estimateGas reverts, so nothing is broadcast; additionally asserted via staticCall.)
 */
const L = require('./_lib');
const { USDC } = L;
const S = 'S5';

async function main() {
    await L.assertStaging();
    const R = new L.Results(S);
    const { mp } = L.contracts();
    const cOwner = L.contracts(L.deployer);
    R.check('owner == deployer (we are calling as the real owner)', (await mp.owner()) === L.deployer.address);
    R.check('migrationFinalized() == true', (await mp.migrationFinalized()) === true);
    const A = L.roleWallet('A');
    const aId = Number(await L.contracts().reg.addressToAgentId(A.address));

    const rv1 = await L.expectRevert(cOwner.mp.seedPool(aId, A.address, USDC(1), USDC(1), 0n), 'Migration finalized');
    R.check('owner seedPool reverts "Migration finalized"', rv1.reverted && rv1.matched, rv1.message.slice(0, 80));
    const rv2 = await L.expectRevert(cOwner.mp.seedPosition(aId, L.deployer.address, USDC(1), 0n, 1n), 'Migration finalized');
    R.check('owner seedPosition reverts "Migration finalized"', rv2.reverted && rv2.matched, rv2.message.slice(0, 80));
    const rv3 = await L.expectRevert(cOwner.mp.setMigrationFinalized(), 'Migration finalized');
    R.check('owner setMigrationFinalized reverts "Migration finalized" (idempotent, irreversible)', rv3.reverted && rv3.matched, rv3.message.slice(0, 80));
    // non-owner: Ownable check comes first
    const rv4 = await L.expectRevert(L.contracts(A).mp.seedPool(aId, A.address, USDC(1), USDC(1), 0n), 'OwnableUnauthorizedAccount');
    R.check('non-owner seedPool reverts OwnableUnauthorizedAccount', rv4.reverted && rv4.matched, rv4.message.slice(0, 80));
    // the legacy V6.0 staging marketplace (still live) — read-only comparison
    const legacy = new L.ethers.Contract(L.cfg.agentLiquidityMarketplace_v6_0_legacy_still_live, L.ABI.mp, L.provider);
    let legacyFinal = null; try { legacyFinal = await legacy.migrationFinalized(); } catch (e) { legacyFinal = `err ${e.message.slice(0, 40)}`; }
    R.note('legacy V6.0 staging marketplace migrationFinalized (read-only)', String(legacyFinal));
    R.finish();
}
main().catch((e) => { console.error(e); process.exit(1); });
