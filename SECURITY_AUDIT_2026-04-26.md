# Security Audit — 2026-04-26

## Scope
Full-tree scan of all git-tracked files for:
- Hardcoded private keys (64-char hex)
- API keys (Alchemy, Moonpay, Privy, Etherscan-family, Stripe, AWS, Sentry, Moltbook)
- Mnemonic phrases
- `.env` tracking & `.gitignore` coverage

## Methodology
```bash
# Private key assignments
git ls-files | xargs grep -nE "(privateKey|PRIVATE_KEY)" | \
  grep -E "0x[a-fA-F0-9]{60,}" | grep -vE "process\.env|0x000000000"

# Specific known compromised keys
git ls-files | xargs grep -n "<known_key_suffix>"

# API keys
git ls-files | xargs grep -lE "alchemy\.com/v2/[a-zA-Z0-9_-]{15,}"
git ls-files | xargs grep -nE "moltbook_sk_"
git ls-files | xargs grep -nE "(BASESCAN|ETHERSCAN|ARBISCAN)_API_KEY"

# Other secrets
git ls-files | xargs grep -nE "(AKIA[A-Z0-9]{16}|sk_live_[a-zA-Z0-9]{24,}|sntrys_)"

# Mnemonics
git ls-files | xargs grep -nE "mnemonic\s*[:=]"
```

## Findings & Remediation

### 🔴 Critical: Compromised mainnet private key (3 files, all fixed)

The known-compromised key `0x4fd4d9c9...02ac` (already drained on Base Mainnet during the prior MetaMask incident) was found in:

| File | Line | Action |
|---|---|---|
| `COMPLAINT_TO_ANTHROPIC.md` | 39, 104 | Masked in commit `1a06eff` |
| `FBI_IC3_CYBERCRIME_REPORT.md` | 91 | Masked in commit `fe5cf14` |
| `SECURITY_INCIDENT_REPORT.md` | 16 | Masked in commit `fe5cf14` |

All three now display `0x4fd4d9c9...` (truncated). **Note:** Key still exists in git history; would require `git filter-repo` to fully purge.

### 🟡 Medium: Testnet keys in tracked config files (untracked)

Two JSON files contained Arc Testnet private keys (no real value but bad practice):

| File | Keys | Action |
|---|---|---|
| `test-agents.json` | 4 keys (Alice, Bob, Carol, Dave) | `git rm --cached` in `fe5cf14` |
| `fresh-agents-config.json` | 3 keys (Fresh Agent 1-3) | `git rm --cached` in `fe5cf14` |

Both files remain on local disk for testing but are no longer in version control.
Updated `.gitignore` patterns:
```
test-agents.json
fresh-agents-config.json
*-agents-config.json
*-agents.json
```

### ✅ Clean: All other checks

| Check | Result |
|---|---|
| `hardhat.config.js` hardcoded keys | ✅ Only `process.env.PRIVATE_KEY` references and zero-key fallback comparisons |
| `.env` tracked in git? | ✅ Untracked (in `.gitignore`) |
| Local `.env` exists? | ✅ Yes, mode 600, untracked |
| Alchemy API keys in git? | ✅ Only `YOUR_API_KEY_HERE` placeholders in `ALCHEMY_SETUP_GUIDE.md` |
| Moltbook `moltbook_sk_*` in git? | ✅ None |
| Etherscan/Basescan/Arbiscan keys hardcoded? | ✅ Only `your_*_api_key` placeholders |
| AWS / Stripe / Sentry secrets | ✅ None |
| Mnemonic phrases in git? | ✅ None (only `wallet.mnemonic.phrase` reference in script) |
| Other session keys (6f9b69c5, ebd981dc, 41adb1d6, 47471cb7, 8622b721) | ✅ None in tracked files |

### 🔵 Informational: 64-char hex strings that are NOT private keys

The following tracked files contain 64-char hex strings that are intentional and safe:

| File | Type | Safe? |
|---|---|---|
| `.x402-nonces.json` | x402 replay-prevention nonces | ✅ Public by design |
| `deployments/arbitrum.json` | Deployment transaction hashes | ✅ Public on-chain data |
| `src/config/arc-testnet-addresses.json` | Deployment tx hashes | ✅ Public on-chain data |
| `test-results-summary.json` | Transaction hashes from tests | ✅ Public on-chain data |
| `abis/*.json` | Contract bytecode in artifacts | ✅ Compiled code |
| Various `*REPORT*.md` files | Tx hashes for reference | ✅ Public on-chain data |

## Commits in This Audit

```
fe5cf14  Security: Mask remaining compromised keys + untrack testnet key files
1a06eff  Security: Mask exposed compromised private key in complaint doc
```

## Final Verification

```bash
$ git ls-files | xargs grep -l "4fd4d9c9340c0dcd1f4845483e488afde4c69685f9ff5deec756fbfc1afb02ac" | wc -l
0

$ git ls-files | xargs grep -nE "(privateKey|PRIVATE_KEY)" | grep -E "0x[a-fA-F0-9]{60,}" | grep -vE "process\.env|0x000000000"
(no output)

$ git check-ignore .env
.env  (✅ ignored)
```

## Outstanding Items / Not Done

1. **Git history purge** — The compromised key (`0x4fd4d9c9...02ac`) and the 7 testnet keys still exist in historical commits. The wallet has zero balance and the testnet keys have no real value, so this is low priority. If desired, run:
   ```bash
   git filter-repo --replace-text <(echo "0x4fd4d9c9340c0dcd1f4845483e488afde4c69685f9ff5deec756fbfc1afb02ac==>0x4fd4d9c9...")
   git push --force origin main
   ```
   Note: This rewrites history and breaks any forks/clones.

2. **Untracked files audit** — This audit covered only tracked files. There are ~150 untracked files (mostly markdown reports and test scripts). If any will be committed in the future, they should be re-scanned first.

3. **Pre-commit hook** — Consider installing a hook (e.g., `gitleaks`, `git-secrets`, `detect-secrets`) to block future secret commits automatically.

## Summary

✅ **0 active mainnet private keys exposed in current `HEAD`**
✅ **0 hardcoded production API keys exposed**
✅ **All previously-found exposures masked or untracked**
✅ **`.env` properly ignored**
⚠️ **Compromised key & testnet keys remain in git history (low risk, drained/testnet)**
