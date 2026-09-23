/**
 * Relay for already-signed transactions. The server only forwards raw bytes;
 * it validates that the transaction targets a known Specular contract (or is
 * an exact USDC approve TO the Specular marketplace) on the requested
 * network, and refuses everything else.
 */
import { ethers } from 'ethers';
import { getContracts } from './chain.js';
import { NetworkConfig } from './networks.js';
import { ALLOWED_FUNCTIONS, decodeCalldata, encodeCalldata, explainRevert, TargetContract } from './prepare.js';
import { cleanErrorText, formatUsdc, maxAmountUsdc, ValidationError } from './validate.js';

const MAX_RAW_BYTES = 16 * 1024;

export interface ValidatedSignedTx {
  hash: string;
  from: string;
  to: string;
  target: TargetContract;
  functionName: string;
  args: Record<string, string>;
  chainId: number;
  nonce: number;
  gasLimit: string;
  summary: string;
}

export function validateSignedTx(cfg: NetworkConfig, raw: unknown): ValidatedSignedTx {
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw) || raw.length % 2 !== 0) {
    throw new ValidationError('signedTransaction must be 0x-prefixed hex (the RLP-encoded, signed transaction)', 'signedTransaction');
  }
  if ((raw.length - 2) / 2 > MAX_RAW_BYTES) throw new ValidationError(`signedTransaction exceeds ${MAX_RAW_BYTES} bytes`, 'signedTransaction');

  let tx: ethers.Transaction;
  try {
    tx = ethers.Transaction.from(raw);
  } catch (e) {
    // H-11: never echo ethers' parenthetical detail block (code=/version=/buffer=) back to the caller.
    throw new ValidationError(`signedTransaction could not be decoded: ${cleanErrorText(e, 120) || 'not a valid RLP-encoded transaction'}`, 'signedTransaction');
  }
  if (!tx.isSigned() || !tx.from) throw new ValidationError('transaction is not signed; sign it with your own wallet first', 'signedTransaction');
  if (Number(tx.chainId) !== cfg.chainId) {
    throw new ValidationError(`transaction chainId ${tx.chainId} does not match ${cfg.name} (chainId ${cfg.chainId})`, 'signedTransaction');
  }
  if (tx.value !== 0n) throw new ValidationError('Specular transactions must carry value 0; refusing to relay a native-token transfer', 'signedTransaction');
  if (!tx.to) throw new ValidationError('contract-creation transactions are not relayed', 'signedTransaction');

  const to = ethers.getAddress(tx.to);
  const { marketplace, registry, usdc } = cfg.addresses;
  let target: TargetContract;
  if (to === marketplace) target = 'marketplace';
  else if (to === registry) target = 'registry';
  else if (to === usdc) target = 'usdc';
  else throw new ValidationError(`transaction targets ${to}, which is not a Specular contract on ${cfg.name} (marketplace ${marketplace}, registry ${registry}, USDC ${usdc})`, 'signedTransaction');

  if (tx.data.length < 10) throw new ValidationError('transaction has no calldata', 'signedTransaction');
  let decoded: { name: string; args: unknown[] };
  try {
    decoded = decodeCalldata(target, tx.data);
  } catch {
    throw new ValidationError(`calldata does not decode to a known ${target} function`, 'signedTransaction');
  }
  if (!ALLOWED_FUNCTIONS[target].includes(decoded.name)) {
    throw new ValidationError(`${target}.${decoded.name} is not relayable (allowed: ${ALLOWED_FUNCTIONS[target].join(', ')})`, 'signedTransaction');
  }
  // H-1 (2026-09-20): the ABI decoder tolerates trailing bytes, so a tx whose
  // calldata is "allow-listed call + junk" decoded fine and was relayed. Only
  // the exact canonical encoding of the decoded call is relayable.
  const canonical = encodeCalldata(target, decoded.name, decoded.args);
  if (canonical.toLowerCase() !== tx.data.toLowerCase()) {
    throw new ValidationError(`calldata is not the canonical ABI encoding of ${target}.${decoded.name} (${(tx.data.length - canonical.length) / 2} unexpected byte(s)); re-encode the call exactly as prepare_* returns it`, 'signedTransaction');
  }

  const args: Record<string, string> = {};
  let summary: string;
  if (target === 'usdc') {
    const [spender, amount] = decoded.args as [string, bigint];
    if (ethers.getAddress(spender) !== marketplace) {
      throw new ValidationError(`USDC approve spender ${spender} is not the Specular marketplace ${marketplace}; refusing to relay`, 'signedTransaction');
    }
    const cap = ethers.parseUnits(maxAmountUsdc().toString(), 6);
    if (amount === ethers.MaxUint256 || amount > cap) {
      throw new ValidationError(`USDC approve of ${amount === ethers.MaxUint256 ? 'unlimited' : formatUsdc(amount)} exceeds the exact-approval cap (${maxAmountUsdc()} USDC); approve only what the next call needs`, 'signedTransaction');
    }
    args.spender = spender;
    args.amountUsdc = formatUsdc(amount);
    summary = `approve marketplace for exactly ${formatUsdc(amount)} USDC`;
  } else {
    decoded.args.forEach((v, i) => (args[String(i)] = typeof v === 'object' && v !== null ? JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)) : String(v)));
    summary = `${target}.${decoded.name}(${Object.values(args).join(', ')})`;
  }

  return {
    hash: tx.hash!,
    from: tx.from,
    to,
    target,
    functionName: decoded.name,
    args,
    chainId: cfg.chainId,
    nonce: tx.nonce,
    gasLimit: tx.gasLimit.toString(),
    summary,
  };
}

export async function broadcastSignedTx(cfg: NetworkConfig, raw: unknown) {
  const v = validateSignedTx(cfg, raw);
  const { provider } = getContracts(cfg);
  try {
    const resp = await provider.broadcastTransaction(raw as string);
    return {
      network: cfg.name,
      realMoney: cfg.realMoney,
      accepted: true,
      hash: resp.hash,
      from: v.from,
      to: v.to,
      call: v.summary,
      explorer: `${cfg.explorerTx}${resp.hash}`,
      next: 'Poll get_transaction with this hash until status is confirmed or reverted.',
    };
  } catch (e) {
    const { reason, plain } = explainRevert(e);
    const msg = (e as Error).message || '';
    let hint = plain;
    if (/nonce too low|already known|replacement/i.test(msg)) hint = 'The RPC already has a transaction with this nonce (already broadcast, or nonce reused).';
    else if (/insufficient funds/i.test(msg)) hint = 'The signing wallet cannot pay gas on this network.';
    else if (/intrinsic gas|gas limit/i.test(msg)) hint = 'The signed gasLimit is too low for this call; re-sign using the gasEstimate from the prepared transaction.';
    throw new ValidationError(`broadcast rejected by RPC: ${hint} (${reason})`, 'signedTransaction');
  }
}
