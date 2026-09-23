/**
 * Minimal live verification that the SDK collateral-approval FALLBACK works
 * against the DEPLOYED Base V6 (which pulls slightly more collateral than the
 * exact formula). Reuses the already-onboarded throwaway agent (agentId 7).
 * Funds ~2 USDC + a little ETH from the secure wallet, runs supply→borrow(0.5)→
 * repay→withdraw, then sweeps EVERYTHING back. All amounts recovered.
 */
require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const { SpecularQuickstart } = require("../src/sdk/SpecularQuickstart.js");

const RPC = "https://mainnet.base.org";
const ba = require("../src/config/base-addresses.json");
const usdcAbi = ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"];

async function main() {
    const keyFiles = fs.readdirSync("/tmp").filter(f => f.startsWith("agent-journey-") && f.endsWith(".json"));
    if (!keyFiles.length) throw new Error("no throwaway agent key in /tmp");
    const key = JSON.parse(fs.readFileSync(path.join("/tmp", keyFiles.sort().at(-1)), "utf8"));

    const provider = new ethers.JsonRpcProvider(RPC, 8453, { batchMaxCount: 1 });
    const funder = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const agent = new ethers.Wallet(key.privateKey, provider);
    const usdcF = new ethers.Contract(ba.usdc, usdcAbi, funder);
    const usdcA = new ethers.Contract(ba.usdc, usdcAbi, agent);

    console.log(`Agent ${agent.address} | funder ${funder.address}`);

    // Fund the agent: 2 USDC + 0.0002 ETH for gas.
    console.log("Funding agent (2 USDC + 0.0002 ETH)…");
    await (await usdcF.transfer(agent.address, ethers.parseUnits("2", 6))).wait();
    await (await funder.sendTransaction({ to: agent.address, value: ethers.parseEther("0.0002") })).wait();

    const sdk = new SpecularQuickstart(agent, "base");
    const onb = await sdk.onboard();
    console.log(`onboard OK (agentId ${onb.agentId})`);

    console.log("supply 1 USDC…");
    await sdk.supply(onb.agentId, 1);

    console.log("borrow 0.5 USDC (7d) — exercises the collateral fallback…");
    const loan = await sdk.borrow(0.5, 7);
    console.log(`  ✅ BORROW SUCCEEDED against deployed Base V6 — loanId ${loan.loanId}, tx ${loan.tx}`);

    console.log("repay…");
    const repayHash = await sdk.repay(loan.loanId);
    console.log(`  ✅ repay OK — ${repayHash}`);

    console.log("withdraw the supplied 1 USDC…");
    await sdk.withdraw(onb.agentId, 1);

    // Sweep everything back (robust against RPC staleness: settle + re-read loop).
    console.log("sweeping all USDC back to funder…");
    for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 4000));
        const bal = await usdcA.balanceOf(agent.address);
        if (bal === 0n) break;
        await (await usdcA.transfer(funder.address, bal)).wait();
        console.log(`  swept ${ethers.formatUnits(bal, 6)} USDC`);
    }
    const finalAgent = await usdcA.balanceOf(agent.address);
    const finalFunder = await usdcF.balanceOf(funder.address);
    console.log(`\nagent USDC final:  ${ethers.formatUnits(finalAgent, 6)} (dust ETH left for gas)`);
    console.log(`funder USDC now:   ${ethers.formatUnits(finalFunder, 6)}`);
    console.log(finalAgent === 0n ? "\n=== ✅ VERIFIED: fallback works on deployed Base; all USDC recovered ===" : "\n⚠️  agent still holds USDC — re-run sweep");
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
