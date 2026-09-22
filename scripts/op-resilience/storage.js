// Storage-slot helpers for AgentLiquidityMarketplaceV6 (V6.1).
// Used ONLY by the local violation harness to engineer corrupt states that no
// public function can produce (e.g. a duplicate poolLenders entry — that is
// exactly what the §B1 fix prevents). Every slot is asserted against the
// contract's own view getters before it is written (see verifySlots).

const { ethers } = require('hardhat');

// Declaration order: Ownable(_owner) Ownable2Step(_pendingOwner)
// ReentrancyGuard(_status) Pausable(_paused) then V6 state.
const SLOT = {
    _owner: 0,
    _pendingOwner: 1,
    _status: 2,
    _paused: 3,
    agentPools: 4,
    positions: 5,
    poolLenders: 6,
    loans: 7,
    agentLoans: 8,
    nextLoanId: 9,
    platformFeeRate: 10,
    accumulatedFees: 11,
    minHoldForReputationReward: 12,
    bindBorrowToPoolCreator: 13,
    minSupplyAmount: 14,
    agentPoolIds: 15,
    activeLoanCount: 16,
    outstandingPrincipal: 17,
    isInPoolLenders: 18,
    migrationFinalized: 19,
    pendingTranche: 20,
    activeLoanIds: 21,
    repayments: 22,
    lateRepayCount: 23,
    lateSecondsTotal: 24,
};

const h32 = v => ethers.toBeHex(v, 32);
const mapSlot = (key, slot) => ethers.keccak256(ethers.concat([h32(key), h32(slot)]));
const map2Slot = (k1, k2, slot) => ethers.keccak256(ethers.concat([h32(k2), mapSlot(k1, slot)]));
const arrayData = slot => BigInt(ethers.keccak256(h32(slot)));

async function getStorage(addr, slot) {
    return await ethers.provider.send('eth_getStorageAt', [addr, h32(slot), 'latest']);
}
async function setStorage(addr, slot, value) {
    await ethers.provider.send('hardhat_setStorageAt', [addr, h32(slot), h32(value)]);
}

// Assert the slot map against the contract's public getters. Throws on mismatch,
// so a harness run can never silently corrupt the wrong slot.
async function verifySlots(v6, agentId, lender) {
    const addr = await v6.getAddress();
    const checks = [];
    const eq = (name, got, want) => checks.push({ name, got: got.toString(), want: want.toString(), ok: BigInt(got) === BigInt(want) });

    eq('_owner', BigInt(await getStorage(addr, SLOT._owner)), BigInt(await v6.owner()));
    eq('_paused', BigInt(await getStorage(addr, SLOT._paused)), (await v6.paused()) ? 1n : 0n);
    eq('nextLoanId', BigInt(await getStorage(addr, SLOT.nextLoanId)), await v6.nextLoanId());
    eq('accumulatedFees', BigInt(await getStorage(addr, SLOT.accumulatedFees)), await v6.accumulatedFees());
    eq('minSupplyAmount', BigInt(await getStorage(addr, SLOT.minSupplyAmount)), await v6.minSupplyAmount());
    eq('activeLoanCount', BigInt(await getStorage(addr, mapSlot(agentId, SLOT.activeLoanCount))), await v6.activeLoanCount(agentId));
    eq('outstandingPrincipal', BigInt(await getStorage(addr, mapSlot(agentId, SLOT.outstandingPrincipal))), await v6.outstandingPrincipal(agentId));
    // agentPools[agentId].availableLiquidity is field #3 (0-based) of the struct
    const poolBase = BigInt(mapSlot(agentId, SLOT.agentPools));
    eq('pool.availableLiquidity', BigInt(await getStorage(addr, poolBase + 3n)), (await v6.getAgentPool(agentId))[2]);
    eq('pool.totalLoaned', BigInt(await getStorage(addr, poolBase + 4n)), (await v6.getAgentPool(agentId))[3]);
    // poolLenders[agentId].length
    eq('poolLenders.length', BigInt(await getStorage(addr, mapSlot(agentId, SLOT.poolLenders))), (await v6.getAgentPool(agentId))[6]);
    // positions[agentId][lender].amount
    const posBase = BigInt(map2Slot(agentId, lender, SLOT.positions));
    eq('position.amount', BigInt(await getStorage(addr, posBase)), (await v6.positions(agentId, lender)).amount);
    // activeLoanIds[agentId].length
    eq('activeLoanIds.length', BigInt(await getStorage(addr, mapSlot(agentId, SLOT.activeLoanIds))), BigInt((await v6.getActiveLoanIds(agentId)).length));
    // lateRepayCount[agentId]
    eq('lateRepayCount', BigInt(await getStorage(addr, mapSlot(agentId, SLOT.lateRepayCount))), await v6.lateRepayCount(agentId));

    const bad = checks.filter(c => !c.ok);
    if (bad.length) throw new Error('storage slot map MISMATCH: ' + JSON.stringify(bad, null, 2));
    return checks;
}

module.exports = { SLOT, h32, mapSlot, map2Slot, arrayData, getStorage, setStorage, verifySlots };
