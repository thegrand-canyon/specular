#!/usr/bin/env node
// Copies the three contract ABIs the MCP server needs out of the hardhat
// artifacts (which are gitignored) into mcp-server/abi/ so the server can be
// built and deployed without a hardhat compile. Run from anywhere.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const out = path.resolve(here, '..', 'abi');
const contracts = ['AgentLiquidityMarketplaceV6', 'AgentRegistryV2', 'ReputationManagerV3'];

fs.mkdirSync(out, { recursive: true });
let updated = 0;
for (const name of contracts) {
  const src = path.join(repoRoot, 'artifacts', 'contracts', 'core', `${name}.sol`, `${name}.json`);
  const dst = path.join(out, `${name}.json`);
  if (!fs.existsSync(src)) {
    if (!fs.existsSync(dst)) {
      console.error(`missing artifact ${src} and no bundled ${dst}; run "npx hardhat compile" in the repo root`);
      process.exit(1);
    }
    continue;
  }
  const { abi } = JSON.parse(fs.readFileSync(src, 'utf8'));
  fs.writeFileSync(dst, JSON.stringify({ contractName: name, abi }, null, 2) + '\n');
  updated++;
}
console.log(`abi: ${updated} file(s) refreshed from artifacts -> ${out}`);
