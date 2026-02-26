# Arbitrum API Deployment Guide

## ✅ What Was Updated

The Specular Multi-Network API has been updated to support Arbitrum One:

### Files Modified:
1. **`src/api/MultiNetworkAPI.js`**
   - Added Arbitrum to NETWORKS configuration
   - Updated API version from 2.1.0 → 2.2.0
   - Updated all endpoint documentation to include `arbitrum`

2. **`src/config/arbitrum-addresses.json`** (NEW)
   - Contract addresses for Arbitrum deployment
   - Verified contract URLs

### Current Status:
- ✅ Local testing passed
- ✅ All endpoints working (`/health`, `/status`, `/agents`, `/pools`, `/networks`)
- ✅ Arbitrum contract addresses configured
- ⏳ Railway deployment pending

---

## 🚀 Railway Deployment Steps

### Option 1: Auto-Deploy (Recommended)
If your Railway project is connected to GitHub with auto-deploy enabled:

1. **Commit and push the changes:**
   ```bash
   git add src/api/MultiNetworkAPI.js src/config/arbitrum-addresses.json
   git commit -m "Add Arbitrum One support to API"
   git push origin main
   ```

2. **Railway will automatically:**
   - Detect the changes
   - Rebuild the service
   - Deploy the updated API

3. **Verify deployment:**
   - Visit: `https://specular-production.up.railway.app/networks`
   - Should show: `arc`, `base`, `arbitrum`

### Option 2: Manual Deploy via Railway CLI

1. **Install Railway CLI** (if not already installed):
   ```bash
   npm install -g @railway/cli
   ```

2. **Login to Railway:**
   ```bash
   railway login
   ```

3. **Link to your project:**
   ```bash
   railway link
   ```

4. **Deploy:**
   ```bash
   railway up
   ```

### Option 3: Manual Deploy via Railway Dashboard

1. Go to https://railway.app/dashboard
2. Select your Specular project
3. Click on the API service
4. Go to "Deployments" tab
5. Click "Deploy Latest"

---

## 🔧 Environment Variables (Optional)

You can optionally set these environment variables in Railway:

```bash
ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc  # Default is already set in code
DEFAULT_NETWORK=base                            # Or set to 'arbitrum' if desired
```

To set environment variables in Railway:
1. Go to your project dashboard
2. Select the API service
3. Click "Variables" tab
4. Add the variables above (if needed)

---

## ✅ Testing After Deployment

Once deployed, test the following endpoints:

### 1. Check Networks
```bash
curl https://specular-production.up.railway.app/networks
```
Expected: Should list `arc`, `base`, `arbitrum`

### 2. Health Check
```bash
curl "https://specular-production.up.railway.app/health?network=arbitrum"
```
Expected: `{"ok":true,"network":"arbitrum","chainId":42161,...}`

### 3. Status Check
```bash
curl "https://specular-production.up.railway.app/status?network=arbitrum"
```
Expected: `{"network":"arbitrum","networkName":"Arbitrum One","totalPools":0,"tvl":"$0.00"}`

### 4. Discovery Endpoint
```bash
curl "https://specular-production.up.railway.app/.well-known/specular.json?network=arbitrum"
```
Expected: Should return all Arbitrum contract addresses

### 5. Agents Endpoint
```bash
curl "https://specular-production.up.railway.app/agents?network=arbitrum"
```
Expected: `{"network":"arbitrum","totalAgents":0,"agents":[]}`

---

## 📊 Arbitrum Contract Addresses

| Contract | Address | Verified |
|----------|---------|----------|
| **AgentRegistryV2** | [`0x6F1EbF50290f6D4A9947E9EB77f98a683684fBF5`](https://arbiscan.io/address/0x6F1EbF50290f6D4A9947E9EB77f98a683684fBF5#code) | ✅ |
| **ReputationManagerV3** | [`0x1577Eb9985CcA859F25ED2EDaeD16A464ADFaE5e`](https://arbiscan.io/address/0x1577Eb9985CcA859F25ED2EDaeD16A464ADFaE5e#code) | ✅ |
| **AgentLiquidityMarketplace** | [`0xb9996de05fD514A0cB2B81fa25448EECD4559Aaa`](https://arbiscan.io/address/0xb9996de05fD514A0cB2B81fa25448EECD4559Aaa#code) | ✅ |
| **USDC** | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | Native USDC |

---

## 🎯 Next Steps After Deployment

1. **Update Frontend Dashboard**
   - Add Arbitrum to network selector
   - Update contract addresses in frontend config

2. **Test End-to-End**
   - Register a test agent on Arbitrum
   - Create a pool
   - Supply liquidity
   - Verify API returns correct data

3. **Update Documentation**
   - Update README.md to mention Arbitrum support
   - Update API documentation

4. **Marketing Announcement**
   - Tweet about Arbitrum launch
   - Post on Moltbook
   - Reddit posts in r/arbitrum

5. **Grant Application**
   - Write and submit Arbitrum Trailblazer grant
   - Include deployed contract links
   - Mention live API endpoints

---

## 📝 Deployment Checklist

- [ ] Code committed to Git
- [ ] Pushed to GitHub (if using auto-deploy)
- [ ] Railway deployment triggered
- [ ] Deployment successful (check Railway logs)
- [ ] `/networks` endpoint shows `arbitrum`
- [ ] `/health?network=arbitrum` returns OK
- [ ] `/status?network=arbitrum` returns correct data
- [ ] Discovery endpoint returns contract addresses
- [ ] Frontend updated (next task)
- [ ] Documentation updated
- [ ] Grant application written

---

## 🔗 Important Links

- **API URL:** https://specular-production.up.railway.app
- **Railway Dashboard:** https://railway.app/dashboard
- **Arbitrum Contracts:** See ARBITRUM_DEPLOYMENT_SUMMARY.md
- **Grant Application:** See ARBITRUM_DEPLOYMENT_GUIDE.md (Section: Grant Application)

---

**API version:** 2.2.0
**Date:** February 26, 2026
**Status:** ✅ Ready to deploy
