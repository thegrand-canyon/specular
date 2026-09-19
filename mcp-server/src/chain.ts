/**
 * Read-only chain access: one cached JsonRpcProvider per network, contract
 * handles, and an RPC staleness check (block timestamp vs. wall clock).
 * Nothing in this module can sign.
 */
import { ethers } from 'ethers';
import { ABI, NetworkConfig } from './networks.js';

const providers = new Map<string, ethers.JsonRpcProvider>();

export const STALE_AFTER_SECONDS = 5 * 60;

export function getProvider(cfg: NetworkConfig): ethers.JsonRpcProvider {
  const key = `${cfg.name}|${cfg.rpcUrl}`;
  let p = providers.get(key);
  if (!p) {
    p = new ethers.JsonRpcProvider(cfg.rpcUrl, { chainId: cfg.chainId, name: cfg.name }, {
      staticNetwork: true,
      batchMaxCount: 1,
    });
    providers.set(key, p);
  }
  return p;
}

export interface Contracts {
  provider: ethers.JsonRpcProvider;
  marketplace: ethers.Contract;
  registry: ethers.Contract;
  reputation: ethers.Contract;
  usdc: ethers.Contract;
}

export function getContracts(cfg: NetworkConfig): Contracts {
  const provider = getProvider(cfg);
  return {
    provider,
    marketplace: new ethers.Contract(cfg.addresses.marketplace, ABI.marketplace, provider),
    registry: new ethers.Contract(cfg.addresses.registry, ABI.registry, provider),
    reputation: new ethers.Contract(cfg.addresses.reputation, ABI.reputation, provider),
    usdc: new ethers.Contract(cfg.addresses.usdc, ABI.usdc, provider),
  };
}

export interface RpcStatus {
  blockNumber: number;
  blockTimestamp: number;
  ageSeconds: number;
  stale: boolean;
  warning?: string;
}

/** Compare the latest block timestamp to now; flag > 5 min as stale. */
export async function rpcStatus(cfg: NetworkConfig): Promise<RpcStatus> {
  const block = await getProvider(cfg).getBlock('latest');
  if (!block) throw new Error(`RPC for ${cfg.name} returned no latest block`);
  const now = Math.floor(Date.now() / 1000);
  const ageSeconds = Math.max(0, now - block.timestamp);
  const stale = ageSeconds > STALE_AFTER_SECONDS;
  return {
    blockNumber: block.number,
    blockTimestamp: block.timestamp,
    ageSeconds,
    stale,
    ...(stale
      ? { warning: `RPC data may be stale: latest block is ${ageSeconds}s old (> ${STALE_AFTER_SECONDS}s). Values below may not reflect current chain state.` }
      : {}),
  };
}

/** Wraps an RPC error into a plain-language message without leaking internals. */
export function describeRpcError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|network error|timeout/i.test(msg)) {
    return 'RPC endpoint unreachable or timed out; try again shortly.';
  }
  if (/rate limit|429|too many requests/i.test(msg)) return 'RPC endpoint rate-limited this server; try again shortly.';
  return msg.length > 300 ? msg.slice(0, 300) + '…' : msg;
}
