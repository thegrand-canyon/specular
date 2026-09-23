# Specular Invariant Monitor

**Real-time monitoring daemon for critical invariant violations in Specular marketplace deployments.**

## Overview

This daemon continuously polls Base Mainnet and Arc Testnet to detect the three critical vulnerabilities:

- **§S1**: Fund drain via `claimInterest` (checks `Σ claimed ≤ actual USDC`)
- **§B1**: Duplicate poolLenders causing repay panic (scans `poolLenders[]` arrays)
- **§S5**: DoS via unbounded loops (tracks agent lifetime loan counts)

## Features

- ✅ **Read-only monitoring** - no state mutations, only view calls
- ✅ **Multi-network support** - Base canonical + stale + Arc Testnet
- ✅ **Real-time alerts** - Slack/Discord webhook integration
- ✅ **Structured logging** - JSON output for ingestion by monitoring systems
- ✅ **Graceful degradation** - continues monitoring even if one network fails

## Quick Start

```bash
# Install dependencies (if not already present)
npm install ethers node-fetch

# Basic monitoring (stdout logs only)
BASE_RPC_URL=https://mainnet.base.org \
ARC_TESTNET_RPC_URL=https://arc-testnet.drpc.org \
node invariant-monitor.js

# With Slack alerts
WEBHOOK_URL=https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK \
BASE_RPC_URL=https://mainnet.base.org \
ARC_TESTNET_RPC_URL=https://arc-testnet.drpc.org \
POLL_INTERVAL_SEC=30 \
LOG_LEVEL=INFO \
node invariant-monitor.js
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `BASE_RPC_URL` | `https://mainnet.base.org` | Base mainnet RPC endpoint |
| `ARC_TESTNET_RPC_URL` | `https://arc-testnet.drpc.org` | Arc testnet RPC endpoint |
| `POLL_INTERVAL_SEC` | `60` | Seconds between monitoring cycles |
| `LOG_LEVEL` | `INFO` | Logging level: `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `WEBHOOK_URL` | (none) | Slack/Discord webhook for alerts |

## Output Format

### Normal Operation
```json
{"timestamp":"2026-05-05T10:30:00.000Z","level":"INFO","message":"S1 invariant healthy","network":"base-canonical","actualBalance":"1.500000","claimedTotal":"1.500000","deficit":"0.000000","violatesS1":false}
```

### Invariant Violation
```json
{"timestamp":"2026-05-05T10:30:00.000Z","level":"ERROR","message":"S1 invariant violation detected","network":"base-canonical","actualBalance":"1.500000","claimedTotal":"1.500002","deficit":"0.000002","violatesS1":true}
```

## Alert Conditions

### 🚨 CRITICAL Alerts

- **S1 Fund Drain**: `claimedTotal > actualBalance` by any amount
- **B1 Duplicate Lenders**: Any `poolLenders[]` array contains duplicate addresses
- **S5 DoS Reached**: Any agent exceeds the brick threshold (~6,500 lifetime loans)

### ⚠️  WARNING Alerts

- **S5 DoS Warning**: Any agent exceeds 80% of brick threshold

## Monitored Deployments

### Base Mainnet
- **Canonical**: `0xd7b4dEE74C61844DFA75aEbe224e4635463b1C8f` (current production)
- **Stale**: `0x77f8D49CDE6Ae7481bea38C8a70B5a893bD4d9aF` (legacy instance)

### Arc Testnet
- **Current**: `0x048363A325A5B188b7FF157d725C5e329f0171D3`

## Production Deployment

### Systemd Service

```ini
# /etc/systemd/system/specular-monitor.service
[Unit]
Description=Specular Invariant Monitor
After=network.target

[Service]
Type=simple
User=monitor
WorkingDirectory=/opt/specular-monitor
Environment=BASE_RPC_URL=https://mainnet.base.org
Environment=ARC_TESTNET_RPC_URL=https://arc-testnet.drpc.org
Environment=WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK
Environment=POLL_INTERVAL_SEC=60
Environment=LOG_LEVEL=INFO
ExecStart=/usr/bin/node invariant-monitor.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable specular-monitor.service
sudo systemctl start specular-monitor.service
sudo journalctl -u specular-monitor.service -f
```

### Docker Deployment

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
USER node
CMD ["node", "invariant-monitor.js"]
```

```bash
docker build -t specular-monitor .
docker run -d --name specular-monitor \
  -e BASE_RPC_URL=https://mainnet.base.org \
  -e ARC_TESTNET_RPC_URL=https://arc-testnet.drpc.org \
  -e WEBHOOK_URL=https://hooks.slack.com/... \
  --restart=unless-stopped \
  specular-monitor
```

## Log Ingestion

### Elasticsearch/Logstash
```ruby
# logstash.conf
filter {
  if [fields][service] == "specular-monitor" {
    json {
      source => "message"
    }
    if [violatesS1] == true or [violatesB1] == true or [violatesS5] == true {
      mutate {
        add_tag => [ "critical-alert" ]
      }
    }
  }
}
```

### Prometheus Metrics
```javascript
// Add to monitor (optional)
const client = require('prom-client');
const violations = new client.Gauge({
  name: 'specular_invariant_violations',
  help: 'Current invariant violations',
  labelNames: ['network', 'type']
});
```

## Troubleshooting

### Common Issues

**RPC Rate Limiting**
- Reduce `POLL_INTERVAL_SEC`
- Use dedicated RPC endpoints (Alchemy, Infura)
- Add retry logic with exponential backoff

**Memory Usage**
- Expected: ~50MB baseline + ~10MB per monitored network
- Large pools may cause spikes during `poolLenders[]` enumeration

**Network Connectivity**
- Monitor will continue on partial failures
- Check logs for specific network error patterns
- Webhook failures are logged but don't stop monitoring

### Debug Mode
```bash
LOG_LEVEL=DEBUG node invariant-monitor.js
```

This will output detailed information about each pool scan, RPC call timing, and intermediate calculations.

## Security Notes

- ⚠️  **RPC Endpoints**: Use trusted providers (Alchemy, Infura) for production
- ⚠️  **Webhook URLs**: Treat as sensitive; attackers could spam your channels
- ✅ **No Private Keys**: Monitor is read-only, requires no wallet access
- ✅ **No State Writes**: Uses only `eth_call` and log queries

## License

Same as parent project. This tool is provided for legitimate security monitoring purposes only.