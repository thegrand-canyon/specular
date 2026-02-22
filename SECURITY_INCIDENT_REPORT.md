# Security Incident Report - Private Key Exposure

**Date:** February 21, 2026
**Incident Type:** Private Key Compromise & Theft
**Total Loss:** $327 USDC

---

## Summary

A private key was inadvertently exposed in the Specular Protocol codebase, leading to automated theft of all funds sent to the associated wallet address.

## Compromised Wallet

**Address:** `0x656086A21073272533c8A3f56A94c1f3D8BCFcE2`
**Private Key:** `0x4fd4d9c9340c0dcd1f4845483e488afde4c69685f9ff5deec756fbfc1afb02ac` (COMPROMISED - DO NOT USE)

## Timeline of Events

### Deposits (Victim):
1. **Block 42474712** - $191 USDC deposited
   Tx: `0xcbc6d38da3534d215ec0a3cdb68945a9c0a683ab7fe530edb16e8f68c35711bd`

2. **Block 42474930** - $100 USDC deposited
   Tx: `0x67daa5dec3baffb99f9d8bcfa8fd08a0c78c66a83e8a8840e5ba4a62c8aa6787`

3. **Block 42475191** - $16 USDC deposited
   Tx: `0x9a11370a73ea6ddf23558d544f225b1b841658137e08952b91be8102ee1cfcdf`

4. **Block 42475500** - $20 USDC deposited
   Tx: `0xebaa34dfc5dba5facf24fe2d65e0d3200dd16aa75c44650f49e8661578f3a4d9`

**Total Deposited:** $327 USDC

### Theft Activity:
- All deposits were immediately drained by unauthorized party
- Thief has sent 61 transactions from compromised wallet
- Current balance: $0 USDC, $0 ETH

## Root Cause

The private key was:
1. Hardcoded in 47+ script files in the repository
2. Committed to git 48+ times
3. Publicly exposed on GitHub at `https://github.com/thegrand-canyon/specular`
4. Likely discovered by automated bots scanning for exposed keys

## Remediation Actions Taken

### Immediate (Completed):
- ✅ Generated new secure wallet: `0x800e305A0caDdE6289dFDFEDF38218f45C06F72C`
- ✅ Removed all exposed private keys from codebase (47 files updated)
- ✅ Updated `.gitignore` to prevent future key exposure
- ✅ Committed changes to GitHub (removing keys)
- ✅ Documented incident

### Ongoing:
- Use environment variables only for private keys
- Never commit `.env` files
- Separate wallets for development vs production
- Start with small amounts for testing

## Victim Information

**Victim Wallet:** `0x10d063350854A81A948b5993340a0E4859bD3Ae0`
**Network:** Base Mainnet (Chain ID: 8453)
**Token:** USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)

## Investigation Links

- Compromised Wallet: https://basescan.org/address/0x656086A21073272533c8A3f56A94c1f3D8BCFcE2
- GitHub Repository: https://github.com/thegrand-canyon/specular

## Recovery Status

❌ **Recovery Unsuccessful**

Reasons:
- Funds fully drained (balance = $0)
- Private key publicly exposed (anyone can access)
- Thief likely used mixing services or multiple hops
- Amount ($327) below threshold for law enforcement priority

## Legal Options

1. **File Cybercrime Report:**
   - FBI IC3: https://www.ic3.gov
   - Provide this document as evidence

2. **Contact Exchanges** (if funds went to KYC exchange):
   - Would require tracing transactions on-chain
   - Exchange may freeze if police report filed

3. **Tax Deduction:**
   - Theft loss may be deductible (consult tax advisor)
   - This document serves as evidence

## Lessons Learned

1. **Never** hardcode private keys in source code
2. **Always** use environment variables
3. **Always** add `.env` to `.gitignore`
4. **Test** with small amounts first
5. **Use** dedicated wallets for different purposes
6. **Review** commits before pushing to public repos

## New Security Practices

1. Private keys stored in `.env` only (gitignored)
2. All code references use `process.env.PRIVATE_KEY`
3. Separate development wallet (with minimal funds)
4. Code review before git commits
5. Security audit checklist before deployments

---

**Document Generated:** February 21, 2026
**Status:** Incident Closed - Loss Accepted
**New Wallet:** Secure and operational
