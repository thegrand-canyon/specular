#!/bin/bash

# Security Cleanup Script - Remove all exposed private keys
echo "🔒 Starting security cleanup..."
echo ""

# 1. Replace compromised key in all script files
echo "Step 1: Replacing compromised private key with environment variable..."
find scripts -type f -name "*.js" -exec sed -i '' "s/0x4fd4d9c9340c0dcd1f4845483e488afde4c69685f9ff5deec756fbfc1afb02ac/process.env.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000'/g" {} \;

# 2. Replace in SDK examples
find src/sdk/examples -type f -name "*.js" -exec sed -i '' "s/0x4fd4d9c9340c0dcd1f4845483e488afde4c69685f9ff5deec756fbfc1afb02ac/process.env.PRIVATE_KEY || ''/g" {} \;

# 3. Replace in documentation
find . -maxdepth 1 -type f -name "*.md" -exec sed -i '' "s/PRIVATE_KEY=0x4fd4d9c9340c0dcd1f4845483e488afde4c69685f9ff5deec756fbfc1afb02ac/PRIVATE_KEY=YOUR_PRIVATE_KEY_HERE/g" {} \;

# 4. Clear .env file (keep structure)
echo "Step 2: Clearing .env file..."
cat > .env << 'EOF'
# Private Keys (NEVER COMMIT THESE)
PRIVATE_KEY=

# RPC URLs
ARC_TESTNET_RPC_URL=https://arc-testnet.drpc.org
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org

# API Keys
BASESCAN_API_KEY=

# Moltbook
MOLTBOOK_API_KEY=moltbook_sk_26-zGFlgSuzAezVZNqjqK25I23GJg_CB

# Fee Recipients
FEE_RECIPIENT=
EOF

# 5. Remove test agent key files (they contain private keys)
echo "Step 3: Removing files with hardcoded test keys..."
rm -f arc-test-agents.json
rm -f patient-test-results.json

# 6. Add to .gitignore
echo "Step 4: Updating .gitignore..."
cat >> .gitignore << 'EOF'

# Security - Never commit private keys
.env
*.key
*private-key*
arc-test-agents.json
patient-test-results.json
EOF

echo ""
echo "✅ Cleanup complete!"
echo ""
echo "⚠️  IMPORTANT NEXT STEPS:"
echo "1. Review changes: git diff"
echo "2. Commit changes: git add -A && git commit -m 'Security: Remove all exposed private keys'"
echo "3. Force push to remove history: git push origin main --force"
echo "4. Rotate all exposed keys (generate new ones)"
echo ""
