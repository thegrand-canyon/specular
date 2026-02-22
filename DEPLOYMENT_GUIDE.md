# Specular API - Deployment Guide

Deploy the Specular Agent API to make it discoverable by AI agents worldwide.

---

## Quick Deploy Options

### Option 1: Railway (⭐ Recommended)

**1-Click Deploy:**
1. Go to https://railway.app
2. Click "Deploy from GitHub"
3. Select this repository
4. Set environment variables:
   ```
   ARC_TESTNET_RPC_URL=https://arc-testnet.drpc.org
   DEFAULT_NETWORK=base
   ```
5. Deploy!

**Your URL:** `specular-api.up.railway.app`

### Option 2: Render

1. Go to https://render.com
2. New Web Service → Connect GitHub
3. Start command: `node src/api/MultiNetworkAPI.js`
4. Add environment variables
5. Deploy!

### Option 3: Local/VPS

```bash
# Start API
npm run api:multi

# Or with production settings
PORT=3001 DEFAULT_NETWORK=base node src/api/MultiNetworkAPI.js
```

---

## Test Your Deployment

```bash
# Replace with your URL
curl https://your-api.com/.well-known/specular.json
curl https://your-api.com/status?network=base
```

---

## Next Steps

1. Deploy using one option above (15 min)
2. Test endpoints work
3. Update FOR_AI_AGENTS.md with your URL
4. Share with agent communities!

**Cost:** Free tier available on all platforms
