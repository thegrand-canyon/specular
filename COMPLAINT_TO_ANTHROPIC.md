# Security Incident Report - Claude Code Failure

**To:** Anthropic Support / Claude Code Team
**From:** Peter Schroeder
**Date:** February 21, 2026
**Subject:** Critical Security Flaw - Claude Code Exposed Private Keys Leading to $327 Theft
**Severity:** CRITICAL

---

## Executive Summary

Claude Code (Sonnet 4.5) assisted in writing and deploying code that contained **hardcoded private keys**, which were committed to a public GitHub repository. This led to the theft of **$327 USDC** from automated bots that scan GitHub for exposed private keys.

This is a **critical security failure** that should never occur when using AI coding assistants.

---

## Incident Details

### Timeline

**Previous Session (Context Lost):**
- Claude Code helped develop Specular Protocol smart contracts
- Private keys were hardcoded in test scripts for development
- Code was committed to git with exposed keys
- Repository: https://github.com/thegrand-canyon/specular

**Current Session (February 21, 2026):**
- Session started with keys ALREADY in codebase (from previous session)
- Claude Code helped push additional commits to GitHub
- **Claude Code did NOT audit for security issues before pushing**
- User attempted to add liquidity to Base Mainnet
- User sent $327 USDC to compromised wallet
- Funds were instantly stolen by automated bots

### Compromised Information

**Exposed Private Key:** `0x4fd4d9c9340c0dcd1f4845483e488afde4c69685f9ff5deec756fbfc1afb02ac`
**Associated Wallet:** `0x656086A21073272533c8A3f56A94c1f3D8BCFcE2`
**Exposure Location:** 47+ files in repository
**Git Commits:** 48+ commits containing exposed key
**GitHub URL:** https://github.com/thegrand-canyon/specular

### Stolen Funds

| Date/Block | Amount | Transaction Hash |
|------------|--------|------------------|
| Block 42474712 | $191 USDC | `0xcbc6d38da3534d215ec0a3cdb68945a9c0a683ab7fe530edb16e8f68c35711bd` |
| Block 42474930 | $100 USDC | `0x67daa5dec3baffb99f9d8bcfa8fd08a0c78c66a83e8a8840e5ba4a62c8aa6787` |
| Block 42475191 | $16 USDC | `0x9a11370a73ea6ddf23558d544f225b1b841658137e08952b91be8102ee1cfcdf` |
| Block 42475500 | $20 USDC | `0xebaa34dfc5dba5facf24fe2d65e0d3200dd16aa75c44650f49e8661578f3a4d9` |
| **TOTAL** | **$327 USDC** | |

**Network:** Base Mainnet (Chain ID: 8453)
**Victim Wallet:** `0x10d063350854A81A948b5993340a0E4859bD3Ae0`

---

## Security Failures by Claude Code

### What Claude Code Did Wrong:

1. **Generated code with hardcoded private keys**
   - Created test scripts with private keys directly in source code
   - Did not use environment variables
   - Did not warn about security implications

2. **Failed to audit before git commits**
   - Helped commit code to git without security review
   - Did not scan for exposed secrets
   - Did not check if `.env` was in `.gitignore`

3. **Failed to prevent public exposure**
   - Assisted in pushing to public GitHub repository
   - Did not warn that private keys were being exposed
   - Did not suggest security audit before deployment

4. **Did not proactively warn about risks**
   - Should have warned: "Never commit private keys to git"
   - Should have suggested: "Use environment variables"
   - Should have required: Security audit before any git push

### What Claude Code SHOULD Have Done:

**Before ANY git commit:**
```
⚠️  SECURITY CHECK REQUIRED:
- Scan all files for private keys (0x[64 hex chars])
- Verify .env is in .gitignore
- Confirm no secrets in staged changes
- Warn user of irreversible consequences
```

**When generating test scripts:**
```javascript
// CORRECT:
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  throw new Error('Set PRIVATE_KEY environment variable');
}

// WRONG (what Claude Code did):
const PRIVATE_KEY = '0x4fd4d9c9340c0dcd1f4845483e488afde4c69685f9ff5deec756fbfc1afb02ac';
```

**Before GitHub push:**
- Mandatory security audit
- Explicit user confirmation: "I have verified no secrets are being committed"
- Block push if secrets detected

---

## Impact

### Financial Loss
- **Direct Loss:** $327 USDC stolen
- **Time Loss:** Hours spent investigating and remediating
- **Trust Loss:** Confidence in AI coding assistants

### Security Implications
- Private key permanently compromised
- Wallet address unusable forever
- Potential reputation damage to user's project

### Broader Concerns
- How many other users have exposed keys via Claude Code?
- Are there automated safeguards in Claude Code?
- Why didn't Claude Code's training include security patterns?

---

## Expected Response from Anthropic

### Immediate Actions Needed:

1. **Investigate Claude Code's Security Training**
   - Why doesn't Claude Code automatically detect private keys?
   - Why no built-in security audits before git commits?
   - Why no warnings about hardcoding secrets?

2. **Product Improvements Required:**
   - Add automatic secret detection (pre-commit scanning)
   - Block git operations if secrets found
   - Mandatory security checklist before any deployment
   - Training data should emphasize: "NEVER hardcode private keys"

3. **User Compensation:**
   - User lost $327 due to Claude Code's security failures
   - This was a preventable incident
   - Consider compensating user for financial loss

4. **Public Disclosure:**
   - Warn other Claude Code users to audit their repositories
   - Issue security advisory about this vulnerability class
   - Update documentation with security best practices

### Long-term Improvements:

1. **Enhanced Security Training:**
   - Claude Code should be trained to REFUSE to write hardcoded secrets
   - Automatic environment variable suggestions
   - Built-in security linting

2. **Pre-commit Hooks:**
   - Claude Code should offer to install git hooks
   - Hooks should scan for secrets before allowing commit
   - Require explicit override to commit secrets

3. **Security Audit Mode:**
   - New tool: "Audit my codebase for security issues"
   - Scan for: API keys, private keys, passwords, tokens
   - Generate security report before any deployment

---

## Evidence Provided

1. **Git Repository:** https://github.com/thegrand-canyon/specular
2. **Blockchain Evidence:**
   - Compromised wallet: https://basescan.org/address/0x656086A21073272533c8A3f56A94c1f3D8BCFcE2
   - Victim wallet: https://basescan.org/address/0x10d063350854A81A948b5993340a0E4859bD3Ae0
3. **Transaction Hashes:** Listed above
4. **Code Files:** 47+ files with exposed keys (now remediated)

---

## Remediation Taken (By User & Claude Code)

After the theft was discovered:
- ✅ Generated new secure wallet
- ✅ Removed all exposed keys from codebase (47 files)
- ✅ Updated `.gitignore` to prevent future exposure
- ✅ Committed security fixes
- ✅ Created comprehensive incident documentation

**But the damage was done: $327 USDC permanently lost.**

---

## Request for Action

1. **Acknowledge this security incident**
2. **Investigate Claude Code's security safeguards**
3. **Implement automatic secret detection**
4. **Consider user compensation for financial loss**
5. **Issue public security advisory**
6. **Improve Claude Code's security training**

---

## Contact Information

**User:** Peter Schroeder
**Email:** [User to provide]
**GitHub:** https://github.com/thegrand-canyon/specular
**Incident Date:** February 21, 2026
**Claude Code Version:** Sonnet 4.5 (model: claude-sonnet-4-5-20250929)

---

## Conclusion

This incident demonstrates a **critical gap in Claude Code's security safeguards**. AI coding assistants must have built-in protections against exposing secrets. The fact that Claude Code:

1. Generated code with hardcoded private keys
2. Helped commit this code to git
3. Assisted in pushing to public GitHub
4. Never warned about security implications

...is a **fundamental failure** that resulted in real financial harm.

**This must be addressed immediately to prevent future incidents.**

---

**User Signature:** _________________________
**Date:** February 21, 2026

---

**Appendix A:** Full list of files with exposed keys (available upon request)
**Appendix B:** Git commit history showing key exposure
**Appendix C:** Blockchain transaction evidence
