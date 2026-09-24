// Read-only preflight for the Arc-staging half of the concurrency round.
// Sends nothing. Confirms the chain id, the marketplace identity and the deployer's
// native balance before any throwaway wallet is funded.
require("dotenv").config({ path: "/Users/peterschroeder/Specular/.env" });
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..", "..");
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "src/config/arc-testnet-v6-addresses.json"), "utf8"));
const abi = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, "artifacts/contracts", rel), "utf8")).abi;

const RPCS = [
    process.env.ARC_STAGING_RPC_URL,
    "https://rpc.testnet.arc.io",
    "https://arc-testnet-rpc.publicnode.com",
    process.env.ARC_TESTNET_RPC_URL,
].filter(Boolean);

(async () => {
    for (const url of RPCS) {
        try {
            const p = new ethers.JsonRpcProvider(url, 5042002, { batchMaxCount: 1 });
            const net = await p.getNetwork();
            const bn = await p.getBlockNumber();
            const blk = await p.getBlock(bn);
            const deployer = new ethers.Wallet(process.env.PRIVATE_KEY, p);
            const bal = await p.getBalance(deployer.address);
            const mp = new ethers.Contract(cfg.agentLiquidityMarketplace_v62, abi("core/AgentLiquidityMarketplaceV62.sol/AgentLiquidityMarketplaceV62.json"), p);
            const out = {
                rpc: url, chainId: Number(net.chainId), blockNumber: bn,
                blockGasLimit: blk.gasLimit.toString(), blockTxCount: blk.transactions.length,
                deployer: deployer.address, deployerNative: ethers.formatEther(bal),
                marketplace: cfg.agentLiquidityMarketplace_v62,
                version: await mp.VERSION(), paused: await mp.paused(), owner: await mp.owner(),
                minSupply: (await mp.minSupplyAmount()).toString(),
                feeBps: (await mp.platformFeeRate()).toString(),
                minHold: (await mp.minHoldForReputationReward()).toString(),
                bindM1: await mp.bindBorrowToPoolCreator(),
                nextLoanId: (await mp.nextLoanId()).toString(),
                totalPools: (await mp.totalPools()).toString(),
                feeData: await p.getFeeData().then((f) => ({ gasPrice: f.gasPrice?.toString(), maxFee: f.maxFeePerGas?.toString(), prio: f.maxPriorityFeePerGas?.toString() })),
            };
            console.log(JSON.stringify(out, null, 2));
            if (Number(net.chainId) !== 5042002) throw new Error("WRONG CHAIN — refusing");
            return;
        } catch (e) {
            console.error(`RPC ${url} failed: ${(e.shortMessage || e.message || "").slice(0, 140)}`);
        }
    }
    process.exit(2);
})();
