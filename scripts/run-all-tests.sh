#!/bin/bash

# Comprehensive Test Suite Runner
# Runs all security, network, and integration tests

set -e

echo "════════════════════════════════════════════════════════════"
echo "  SPECULAR PROTOCOL - COMPREHENSIVE TEST SUITE"
echo "════════════════════════════════════════════════════════════"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

FAILED=0
PASSED=0

# Function to run a test
run_test() {
    local name="$1"
    local command="$2"

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Running: $name"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""

    if eval "$command"; then
        echo -e "${GREEN}✅ $name PASSED${NC}"
        ((PASSED++))
    else
        echo -e "${RED}❌ $name FAILED${NC}"
        ((FAILED++))
    fi
}

# 1. Security Audit
run_test "Security Audit" \
    "ARC_TESTNET_RPC_URL=https://arc-testnet.drpc.org /opt/homebrew/opt/node@22/bin/node scripts/security-audit.js"

# 2. Network Tests - Arc Testnet
run_test "Network Stress Test (Arc)" \
    "ARC_TESTNET_RPC_URL=https://arc-testnet.drpc.org DEFAULT_NETWORK=arc /opt/homebrew/opt/node@22/bin/node scripts/network-stress-test.js"

# 3. Network Tests - Base Mainnet
run_test "Network Stress Test (Base)" \
    "DEFAULT_NETWORK=base /opt/homebrew/opt/node@22/bin/node scripts/network-stress-test.js"

# 4. Integration Tests - Arc Testnet
run_test "Integration Test (Arc)" \
    "ARC_TESTNET_RPC_URL=https://arc-testnet.drpc.org DEFAULT_NETWORK=arc /opt/homebrew/opt/node@22/bin/node scripts/integration-test.js"

# 5. Integration Tests - Base Mainnet
run_test "Integration Test (Base)" \
    "DEFAULT_NETWORK=base /opt/homebrew/opt/node@22/bin/node scripts/integration-test.js"

# 6. Protocol Analytics
run_test "Protocol Analytics (Arc)" \
    "ARC_TESTNET_RPC_URL=https://arc-testnet.drpc.org DEFAULT_NETWORK=arc /opt/homebrew/opt/node@22/bin/node scripts/get-protocol-stats.js"

run_test "Protocol Analytics (Base)" \
    "DEFAULT_NETWORK=base /opt/homebrew/opt/node@22/bin/node scripts/get-protocol-stats.js"

# Final Summary
echo ""
echo "════════════════════════════════════════════════════════════"
echo "  FINAL SUMMARY"
echo "════════════════════════════════════════════════════════════"
echo "  Total Tests:  $((PASSED + FAILED))"
echo "  Passed:       $PASSED"
echo "  Failed:       $FAILED"
echo "════════════════════════════════════════════════════════════"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}🎉 ALL TESTS PASSED!${NC}"
    echo ""
    echo "Your protocol is secure and ready for production!"
    echo ""
    exit 0
else
    echo -e "${RED}❌ SOME TESTS FAILED!${NC}"
    echo ""
    echo "Please review the failures above before deploying to production."
    echo ""
    exit 1
fi
