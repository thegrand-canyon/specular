'use strict';
/**
 * AgentMessenger — lightweight XMTP V3 wrapper for Specular agents
 *
 * Wraps @xmtp/node-sdk (V3) to send wallet-to-wallet encrypted messages on
 * loan lifecycle events.  Gracefully no-ops if the XMTP package is not
 * installed or client creation fails.
 *
 * Usage:
 *   const messenger = await AgentMessenger.create(wallet);
 *   await messenger.send(lenderAddress, AgentMessenger.msg.borrowed(loanId, amount, myAddress));
 *   await messenger.send(lenderAddress, AgentMessenger.msg.repaid(loanId, total, myAddress));
 */

const { ethers } = require('ethers');
const crypto     = require('crypto');

// ── Message templates ─────────────────────────────────────────────────────────

const msg = {
    /** Sent by borrower → lender when a loan is approved */
    borrowed(loanId, amountUsdc, agentAddress) {
        return (
            `📥 Specular Protocol: Loan Requested\n\n` +
            `Agent ${agentAddress.slice(0, 10)}... has borrowed from your pool.\n` +
            `• Loan ID: #${loanId}\n` +
            `• Amount:  ${amountUsdc} USDC\n\n` +
            `Funds are now at work. You will be notified upon repayment.`
        );
    },

    /** Sent by borrower → lender when a loan is repaid */
    repaid(loanId, amountUsdc, agentAddress) {
        return (
            `💸 Specular Protocol: Loan Repaid\n\n` +
            `Agent ${agentAddress.slice(0, 10)}... has repaid loan #${loanId}.\n` +
            `• Amount: ${amountUsdc} USDC (principal + interest)\n\n` +
            `Your pool has been credited. Thank you for providing liquidity.`
        );
    },

    /** Sent by borrower → lender on tier promotion */
    promoted(oldTier, newTier, score, agentAddress) {
        return (
            `⭐ Specular Protocol: Agent Tier Promotion\n\n` +
            `Agent ${agentAddress.slice(0, 10)}... has been promoted!\n` +
            `• ${oldTier} → ${newTier}\n` +
            `• New reputation score: ${score}\n\n` +
            `Higher tier = lower default risk for your pool.`
        );
    },

    /** Sent by lender → borrower when supply is added */
    supplied(agentId, amountUsdc, lenderAddress) {
        return (
            `💰 Specular Protocol: Liquidity Supplied\n\n` +
            `${lenderAddress.slice(0, 10)}... has supplied liquidity to pool #${agentId}.\n` +
            `• Amount: ${amountUsdc} USDC\n\n` +
            `You can now borrow against this pool.`
        );
    },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

// IdentifierKind.Ethereum = 0  (const enum from @xmtp/node-bindings)
const IDENTIFIER_KIND_ETHEREUM = 0;

/** Canonical identifier object for an Ethereum address */
function ethId(address) {
    return { identifier: address.toLowerCase(), identifierKind: IDENTIFIER_KIND_ETHEREUM };
}

/** Build a V3-compatible XMTP signer from an ethers Wallet/Signer */
function buildXmtpSigner(wallet) {
    return {
        type: 'EOA',
        getIdentifier: () => ({
            identifier:     wallet.address.toLowerCase(),
            identifierKind: IDENTIFIER_KIND_ETHEREUM,
        }),
        signMessage: async (message) => {
            const sig = await wallet.signMessage(
                typeof message === 'string' ? message : Buffer.from(message),
            );
            return ethers.getBytes(sig);
        },
    };
}

/** Deterministic 32-byte DB encryption key derived from the private key (or random) */
function dbEncryptionKey(wallet) {
    try {
        // Use keccak256(privateKey) so the key is stable across restarts
        const pkBytes = ethers.getBytes(wallet.privateKey);
        const hash    = ethers.keccak256(pkBytes);
        return ethers.getBytes(hash);
    } catch {
        return crypto.randomBytes(32);
    }
}

// ── AgentMessenger class ──────────────────────────────────────────────────────

class AgentMessenger {
    /**
     * @param {object} xmtpClient  - Live @xmtp/node-sdk Client instance
     * @param {string} address     - This agent's wallet address (lowercase)
     */
    constructor(xmtpClient, address) {
        this._client    = xmtpClient;
        this.address    = address.toLowerCase();
        this._dmCache   = new Map();   // address → Dm conversation
        this.sentCount  = 0;
    }

    /**
     * Factory: create a live AgentMessenger, or a silent no-op if XMTP is unavailable.
     *
     * @param {ethers.Wallet|ethers.Signer} wallet
     * @param {string}                      [env='dev']   'dev' | 'production'
     * @returns {Promise<AgentMessenger|NoopMessenger>}
     */
    static async create(wallet, env = 'dev') {
        let Client;
        try {
            ({ Client } = require('@xmtp/node-sdk'));
        } catch {
            // Try legacy package as last resort
            try {
                ({ Client } = require('@xmtp/xmtp-js'));
            } catch {
                console.log('[XMTP] No XMTP SDK found — messaging disabled');
                return new NoopMessenger(wallet.address);
            }
        }

        try {
            const signer = buildXmtpSigner(wallet);
            const client = await Client.create(signer, {
                env,
                dbPath:          null,           // ephemeral — no disk writes
                dbEncryptionKey: dbEncryptionKey(wallet),
            });
            console.log(`[XMTP] V3 client ready | inbox: ${client.inboxId.slice(0, 12)}... (env: ${env})`);
            return new AgentMessenger(client, wallet.address);
        } catch (err) {
            console.log(`[XMTP] Client creation failed: ${err.message} — messaging disabled`);
            return new NoopMessenger(wallet.address);
        }
    }

    /**
     * Send a plain-text message to a recipient Ethereum address.
     * Uses DM conversation caching to avoid re-opening streams.
     *
     * @param {string} toAddress   - Recipient wallet address
     * @param {string} content     - Plain-text message body
     * @returns {Promise<boolean>} - true on success, false on soft error
     */
    async send(toAddress, content) {
        if (!toAddress) return false;
        const to = toAddress.toLowerCase();
        try {
            // Check recipient has XMTP V3 identity
            const canMsgMap = await this._client.canMessage([ethId(to)]);
            if (!canMsgMap.get(to)) {
                console.log(`[XMTP] ${to.slice(0, 10)}... has no XMTP V3 identity — skipping`);
                return false;
            }

            // Reuse cached DM conversation
            let dm = this._dmCache.get(to);
            if (!dm) {
                dm = await this._client.conversations.createDmWithIdentifier(ethId(to));
                this._dmCache.set(to, dm);
            }

            await dm.sendText(content);
            this.sentCount++;
            console.log(`[XMTP] Sent to ${to.slice(0, 10)}... (total sent: ${this.sentCount})`);
            return true;
        } catch (err) {
            console.log(`[XMTP] Send failed: ${err.message}`);
            return false;
        }
    }

    /**
     * Read recent messages from a sender Ethereum address.
     * Syncs conversations before listing to pick up new messages.
     *
     * @param {string} fromAddress
     * @param {number} [limit=10]
     * @returns {Promise<Array<{sent: Date, content: string}>>}
     */
    async readFrom(fromAddress, limit = 10) {
        const from = fromAddress.toLowerCase();
        try {
            await this._client.conversations.sync();
            const dms = this._client.conversations.listDms();
            const dm  = dms.find(d => d.peerInboxId && this._peerMatchesAddress(d, from));
            if (!dm) return [];
            await dm.sync();
            const messages = await dm.messages({ limit });
            return messages
                .filter(m => typeof m.content === 'string')
                .map(m => ({ sent: m.sentAt, content: m.content }));
        } catch (err) {
            console.log(`[XMTP] readFrom failed: ${err.message}`);
            return [];
        }
    }

    /** Helper: check if a Dm's peer address matches (best-effort, no network call) */
    _peerMatchesAddress(dm, address) {
        // In V3 we match via DM cache key or cached conversation
        const cached = [...this._dmCache.entries()].find(([addr, d]) => d === dm);
        return cached ? cached[0] === address : false;
    }
}

// ── NoopMessenger — silent fallback when XMTP is unavailable ─────────────────

class NoopMessenger {
    constructor(address) {
        this.address   = address;
        this.sentCount = 0;
        this._noop     = true;
    }
    async send()     { return false; }
    async readFrom() { return []; }
}

// ── Exports ───────────────────────────────────────────────────────────────────

AgentMessenger.msg  = msg;
AgentMessenger.Noop = NoopMessenger;
module.exports      = { AgentMessenger };
