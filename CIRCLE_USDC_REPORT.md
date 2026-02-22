# Circle (USDC Issuer) - Stolen Funds Report

**To:** Circle Support / Circle Legal
**From:** Peter Schroeder
**Date:** February 21, 2026
**Subject:** Request to Freeze/Track Stolen USDC - $327 Theft
**Priority:** High

---

## Request Summary

I am requesting Circle's assistance in tracking and potentially freezing **$327 USDC** that was stolen from my wallet due to a compromised private key.

While I understand recovery may not be possible, I am filing this report in case the stolen funds were sent to an address that Circle can freeze or if law enforcement becomes involved.

---

## Stolen Funds Details

**Token:** USDC (USD Coin)
**Network:** Base Mainnet (Chain ID: 8453)
**Contract:** `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
**Total Stolen:** $327.00 USDC

---

## Theft Transactions

### Transaction 1: $191 USDC
- **Block:** 42474712
- **Tx Hash:** `0xcbc6d38da3534d215ec0a3cdb68945a9c0a683ab7fe530edb16e8f68c35711bd`
- **From:** 0x10d063350854A81A948b5993340a0E4859bD3Ae0 (My wallet - VICTIM)
- **To:** 0x656086A21073272533c8A3f56A94c1f3D8BCFcE2 (Compromised wallet)
- **Status:** Stolen immediately upon arrival

### Transaction 2: $100 USDC
- **Block:** 42474930
- **Tx Hash:** `0x67daa5dec3baffb99f9d8bcfa8fd08a0c78c66a83e8a8840e5ba4a62c8aa6787`
- **From:** 0x10d063350854A81A948b5993340a0E4859bD3Ae0 (My wallet - VICTIM)
- **To:** 0x656086A21073272533c8A3f56A94c1f3D8BCFcE2 (Compromised wallet)
- **Status:** Stolen immediately upon arrival

### Transaction 3: $16 USDC
- **Block:** 42475191
- **Tx Hash:** `0x9a11370a73ea6ddf23558d544f225b1b841658137e08952b91be8102ee1cfcdf`
- **From:** 0x10d063350854A81A948b5993340a0E4859bD3Ae0 (My wallet - VICTIM)
- **To:** 0x656086A21073272533c8A3f56A94c1f3D8BCFcE2 (Compromised wallet)
- **Status:** Stolen immediately upon arrival

### Transaction 4: $20 USDC
- **Block:** 42475500
- **Tx Hash:** `0xebaa34dfc5dba5facf24fe2d65e0d3200dd16aa75c44650f49e8661578f3a4d9`
- **From:** 0x10d063350854A81A948b5993340a0E4859bD3Ae0 (My wallet - VICTIM)
- **To:** 0x656086A21073272533c8A3f56A94c1f3D8BCFcE2 (Compromised wallet)
- **Status:** Stolen immediately upon arrival

---

## How the Theft Occurred

1. **Key Exposure:** Private key was accidentally hardcoded in source code
2. **Public Exposure:** Code was pushed to public GitHub repository
3. **Bot Detection:** Automated bots scan GitHub for exposed private keys
4. **Wallet Monitoring:** Bots monitored compromised wallet for incoming funds
5. **Instant Theft:** When USDC arrived, bots immediately drained the wallet

**Compromised Wallet:** 0x656086A21073272533c8A3f56A94c1f3D8BCFcE2
**Thief Activity:** 61 outgoing transactions sent from compromised wallet
**Current Balance:** $0 USDC (fully drained)

---

## Requests to Circle

### 1. Track Stolen Funds
Can Circle trace where the stolen USDC was sent?
- Did it go to a known exchange?
- Was it converted or mixed?
- Is it in a wallet Circle has previously flagged?

### 2. Freeze Funds (If Possible)
If the stolen USDC is in an address that Circle can freeze:
- I am willing to file a police report
- I can provide all transaction evidence
- I will cooperate fully with any investigation

### 3. Flag Compromised Address
Can Circle flag `0x656086A21073272533c8A3f56A94c1f3D8BCFcE2` as compromised?
- This prevents future victims
- Warns exchanges if funds are sent there
- Helps track criminal activity

### 4. Law Enforcement Coordination
If I file a police report and FBI IC3 complaint:
- Will Circle cooperate with law enforcement?
- What information does Circle need from me?
- Is there a process for theft recovery?

---

## Evidence Provided

**Victim Wallet (My Wallet):**
- Address: 0x10d063350854A81A948b5993340a0E4859bD3Ae0
- BaseScan: https://basescan.org/address/0x10d063350854A81A948b5993340a0E4859bD3Ae0

**Compromised Wallet (Thief's Access):**
- Address: 0x656086A21073272533c8A3f56A94c1f3D8BCFcE2
- BaseScan: https://basescan.org/address/0x656086A21073272533c8A3f56A94c1f3D8BCFcE2

**Blockchain Evidence:**
- All transaction hashes listed above
- Network: Base Mainnet
- USDC Contract: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913

---

## Victim Information

**Name:** Peter Schroeder
**Email:** [To be provided]
**Wallet Address:** 0x10d063350854A81A948b5993340a0E4859bD3Ae0
**Incident Date:** February 21, 2026
**Total Loss:** $327.00 USDC
**Network:** Base Mainnet

---

## Circle's USDC Freeze Policy

I understand from Circle's documentation that USDC can be frozen under certain circumstances:

1. **Law Enforcement Request:** With valid legal documentation
2. **Court Order:** With judicial authorization
3. **Sanctions Compliance:** If address is sanctioned
4. **Fraud Prevention:** In cases of verified fraud

**My Situation:**
- This is verified theft (blockchain evidence)
- I am willing to file police report
- I can provide all documentation
- I will cooperate with investigation

**Question:** Does my case qualify for any freeze consideration?

---

## What I've Done

**Security Remediation:**
- ✅ Stopped using compromised wallet
- ✅ Generated new secure wallet
- ✅ Removed private keys from GitHub
- ✅ Updated all security practices

**Reports Filed:**
- ✅ MetaMask (incident report)
- ✅ Anthropic (security failure report)
- ✅ Circle (this report)
- ⏳ FBI IC3 (planning to file)

---

## Requested Response

1. **Acknowledge** receipt of this report
2. **Trace** stolen USDC if possible
3. **Advise** if any recovery options exist
4. **Explain** Circle's process for theft cases
5. **Coordinate** with law enforcement if I file report

---

## Additional Context

While $327 may seem small, this incident highlights:

1. **Security Risks:** AI coding assistants can expose secrets
2. **Bot Activity:** GitHub scanning for private keys is widespread
3. **User Protection:** More can be done to protect users
4. **Theft Patterns:** Automated theft is increasingly common

I hope this report helps Circle:
- Improve security recommendations
- Track theft patterns
- Protect other users
- Potentially assist in recovery

---

## Contact Information

**Name:** Peter Schroeder
**Email:** [To be provided]
**Wallet:** 0x10d063350854A81A948b5993340a0E4859bD3Ae0
**Report Date:** February 21, 2026

**Preferred Contact Method:** Email

---

## Circle Support Links

- Circle Support: https://support.circle.com
- USDC on Base: https://www.circle.com/en/usdc-multichain/base
- Report Fraud: https://support.circle.com/hc/en-us/articles/[appropriate-article]

---

**Thank you for your attention to this matter. I appreciate any assistance Circle can provide.**

---

**Submitted By:** Peter Schroeder
**Date:** February 21, 2026
**Case Status:** Awaiting Response
