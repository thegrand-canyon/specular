# MetaMask Security Incident Report

**To:** MetaMask Support (support@metamask.io)
**From:** Peter Schroeder
**Date:** February 21, 2026
**Subject:** Theft of $327 USDC Due to Compromised Private Key
**Ticket Type:** Security Incident / Theft Report

---

## Incident Summary

I am reporting the theft of **$327 USDC** from my wallet due to a compromised private key that was inadvertently exposed in a public GitHub repository.

While this was not MetaMask's fault, I am filing this report for documentation purposes and to request any assistance MetaMask can provide in tracking or recovering the stolen funds.

---

## Wallet Information

**My Primary Wallet (Victim):**
- Address: `0x10d063350854A81A948b5993340a0E4859bD3Ae0`
- Network: Base Mainnet (Chain ID: 8453)
- Status: SAFE - Not compromised

**Compromised Wallet (Funds Stolen From):**
- Address: `0x656086A21073272533c8A3f56A94c1f3D8BCFcE2`
- Private Key: EXPOSED (publicly available on GitHub)
- Status: PERMANENTLY COMPROMISED - Do not use

---

## Theft Details

### Transactions (Funds Sent to Compromised Wallet):

1. **$191 USDC** - Block 42474712
   - Tx Hash: `0xcbc6d38da3534d215ec0a3cdb68945a9c0a683ab7fe530edb16e8f68c35711bd`
   - Sent from my safe wallet → Compromised wallet
   - **IMMEDIATELY STOLEN**

2. **$100 USDC** - Block 42474930
   - Tx Hash: `0x67daa5dec3baffb99f9d8bcfa8fd08a0c78c66a83e8a8840e5ba4a62c8aa6787`
   - Sent from my safe wallet → Compromised wallet
   - **IMMEDIATELY STOLEN**

3. **$16 USDC** - Block 42475191
   - Tx Hash: `0x9a11370a73ea6ddf23558d544f225b1b841658137e08952b91be8102ee1cfcdf`
   - Sent from my safe wallet → Compromised wallet
   - **IMMEDIATELY STOLEN**

4. **$20 USDC** - Block 42475500
   - Tx Hash: `0xebaa34dfc5dba5facf24fe2d65e0d3200dd16aa75c44650f49e8661578f3a4d9`
   - Sent from my safe wallet → Compromised wallet
   - **IMMEDIATELY STOLEN**

**Total Stolen:** $327 USDC

### How the Theft Occurred:

1. I was developing a DeFi protocol (Specular Protocol)
2. Used an AI coding assistant (Claude Code) that generated test scripts
3. Test scripts contained hardcoded private keys
4. Code was committed to public GitHub repository
5. Automated bots scan GitHub for exposed private keys
6. Bots found the key and monitored the wallet
7. When I sent USDC to the wallet, bots instantly drained it

---

## Evidence

**Compromised Wallet on BaseScan:**
https://basescan.org/address/0x656086A21073272533c8A3f56A94c1f3D8BCFcE2

**GitHub Repository (Keys Now Removed):**
https://github.com/thegrand-canyon/specular

**My Safe Wallet:**
https://basescan.org/address/0x10d063350854A81A948b5993340a0E4859bD3Ae0

---

## Requests for Assistance

### 1. Transaction Tracking
Can MetaMask help identify where the stolen USDC was sent?
- The compromised wallet has sent 61 transactions
- Funds may have gone to a known exchange
- If so, could MetaMask contact the exchange?

### 2. Wallet Flagging
Can MetaMask flag the compromised wallet as "COMPROMISED" in your system?
- Address: `0x656086A21073272533c8A3f56A94c1f3D8BCFcE2`
- This would warn other users if they accidentally try to send to it

### 3. Security Features
Does MetaMask have any features to help prevent this type of incident?
- Warnings when importing known compromised keys?
- Alerts when sending to flagged addresses?
- Security scanning of transactions?

### 4. Recovery Options
Are there ANY recovery options available?
- Contact with exchanges if funds went there?
- Reporting to Circle (USDC issuer)?
- Law enforcement coordination?

---

## What I've Done

**Immediate Actions:**
- ✅ Stopped using compromised wallet
- ✅ Generated new secure wallet
- ✅ Removed private keys from GitHub repository
- ✅ Updated security practices
- ✅ Documented incident thoroughly

**Reports Filed:**
- ✅ MetaMask (this report)
- ✅ Anthropic (Claude Code security failure)
- ⏳ FBI IC3 (cybercrime report) - Planning to file
- ⏳ Circle (USDC issuer) - Planning to contact

---

## Lessons Learned

1. **Never** hardcode private keys in source code
2. **Never** commit private keys to git
3. **Always** use environment variables
4. **Always** audit code before pushing to GitHub
5. **Test** with small amounts first

---

## User Information

**Name:** Peter Schroeder
**Email:** [To be provided]
**MetaMask Wallet:** 0x10d063350854A81A948b5993340a0E4859bD3Ae0
**Incident Date:** February 21, 2026
**Network:** Base Mainnet
**Total Loss:** $327 USDC

---

## Request for Response

1. Acknowledge receipt of this incident report
2. Provide incident tracking number
3. Advise if any recovery options exist
4. Recommend security best practices
5. Consider implementing warnings for compromised addresses

---

## Additional Notes

While I understand that MetaMask is not responsible for user security practices, I hope this report helps:

1. Improve MetaMask's security warnings
2. Identify common attack vectors
3. Potentially assist in recovering funds
4. Help other users avoid similar incidents

Thank you for your time and any assistance you can provide.

---

**Reported By:** Peter Schroeder
**Date:** February 21, 2026
**Status:** Awaiting Response

---

**Attachments:**
- Transaction hashes (listed above)
- Wallet addresses (listed above)
- BaseScan links (provided above)
- GitHub repository link (provided above)
