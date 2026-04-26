#!/bin/sh
set -e

echo "Starting Node.js with explicit memory settings..."
echo "NODE_OPTIONS: $NODE_OPTIONS"
echo "Max Old Space Size: 512 MB"

# Execute Node with explicit flags
exec node --max-old-space-size=512 --expose-gc src/api/MultiNetworkAPI.js
