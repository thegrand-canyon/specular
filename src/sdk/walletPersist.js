/**
 * Specular SDK — wallet persistence for repeatable testing.
 *
 * When running fresh-wallet load tests we kept losing the funded private
 * key on process exit, then having to re-fund. This module persists
 * generated keys so the same fresh wallet can be re-used across runs.
 *
 * TEST-ONLY. Never use this in production. To guard against exactly that,
 * persistence is gated behind an explicit opt-in env flag and keys are stored
 * as ENCRYPTED ethers keystore JSON (never plaintext), requiring a password.
 *
 *   SPECULAR_ALLOW_KEY_PERSIST=1 SPECULAR_KEYSTORE_PASSWORD=... node ...
 *
 *   const w = await loadOrCreateWallet({
 *     label: 'base-load-test',
 *     provider,
 *     persistDir: '/tmp/specular-keys',
 *   });
 */

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const DEFAULT_DIR = path.join(require('os').tmpdir(), 'specular-keys');

// label becomes a filename — reject anything that could escape the dir
// (`../../x`) or collide with path syntax. Alphanumerics, dash, underscore only.
const LABEL_RE = /^[A-Za-z0-9_-]+$/;

function assertLabel(label) {
  if (typeof label !== 'string' || !LABEL_RE.test(label)) {
    throw new Error(`walletPersist: invalid label "${label}" — use [A-Za-z0-9_-] only (no path separators)`);
  }
}

function assertEnabled() {
  if (process.env.SPECULAR_ALLOW_KEY_PERSIST !== '1') {
    throw new Error(
      'walletPersist is disabled: set SPECULAR_ALLOW_KEY_PERSIST=1 to opt in (TEST-ONLY — persists wallet keys to disk).'
    );
  }
}

function requirePassword(opts) {
  const pw = (opts && opts.password) || process.env.SPECULAR_KEYSTORE_PASSWORD;
  if (!pw || String(pw).length < 8) {
    throw new Error('walletPersist: set SPECULAR_KEYSTORE_PASSWORD (>=8 chars) to encrypt the keystore.');
  }
  return String(pw);
}

/**
 * Create the persist dir private, and refuse to use one that isn't ours or is
 * accessible to group/other (a pre-existing world-readable dir would otherwise
 * expose the keystores).
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return;
  }
  const st = fs.statSync(dir);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`walletPersist: refusing to use ${dir} — not owned by current user`);
  }
  if (st.mode & 0o077) {
    // Tighten a too-permissive existing dir rather than silently trusting it.
    fs.chmodSync(dir, 0o700);
  }
}

/**
 * Load a previously persisted wallet by label, or generate + persist a new
 * one. Keys are stored as encrypted ethers keystore JSON. Legacy plaintext
 * files (from before this hardening) are transparently migrated to encrypted
 * form on first load so funded test keys aren't lost.
 *
 * @param {object} opts
 * @param {string} opts.label                - filename stem; [A-Za-z0-9_-] only
 * @param {ethers.Provider} opts.provider    - chain to bind to
 * @param {string} [opts.persistDir]         - where to store; defaults to tmpdir
 * @param {string} [opts.password]           - keystore password (or env)
 * @param {boolean} [opts.forceFresh=false]  - if true, always overwrite
 * @returns {Promise<ethers.Wallet>}
 */
async function loadOrCreateWallet(opts) {
  if (!opts || !opts.label || !opts.provider) {
    throw new Error('loadOrCreateWallet requires { label, provider }');
  }
  assertEnabled();
  assertLabel(opts.label);
  const password = requirePassword(opts);

  const dir = opts.persistDir || DEFAULT_DIR;
  ensureDir(dir);
  const file = path.join(dir, `${opts.label}.json`);

  const writeKeystore = async (wallet) => {
    const keystore = await wallet.encrypt(password);
    fs.writeFileSync(file, keystore, { mode: 0o600 });
  };

  if (!opts.forceFresh && fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }

    if (parsed && parsed.privateKey) {
      // Legacy plaintext file — migrate to encrypted keystore, then use it.
      console.warn(`walletPersist: migrating legacy plaintext keyfile ${file} to encrypted keystore`);
      const w = new ethers.Wallet(parsed.privateKey, opts.provider);
      await writeKeystore(w);
      return w;
    }
    // Encrypted keystore path.
    const w = await ethers.Wallet.fromEncryptedJson(raw, password);
    return w.connect(opts.provider);
  }

  const w = ethers.Wallet.createRandom().connect(opts.provider);
  await writeKeystore(w);
  return w;
}

/**
 * Look up the address for a persisted wallet without instantiating it or
 * needing the password. Works for both encrypted keystores (which embed the
 * address in cleartext) and legacy plaintext files. Returns null if not found.
 */
function peekAddress(label, persistDir) {
  assertLabel(label);
  const dir = persistDir || DEFAULT_DIR;
  const file = path.join(dir, `${label}.json`);
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed.address) {
    // Keystore stores the address without 0x / checksum.
    return parsed.address.startsWith('0x') ? parsed.address : ethers.getAddress('0x' + parsed.address);
  }
  return null;
}

module.exports = {
  loadOrCreateWallet,
  peekAddress,
  DEFAULT_DIR,
};
