# Webhook Alert Setup Guide

## **Slack Integration**

### **1. Create Slack App**
1. Go to https://api.slack.com/apps
2. Click "Create New App" → "From scratch"
3. Name: "Specular Monitor"
4. Select your workspace

### **2. Configure Incoming Webhooks**
1. In your app settings, go to "Incoming Webhooks"
2. Toggle "Activate Incoming Webhooks" to On
3. Click "Add New Webhook to Workspace"
4. Select the channel for alerts (e.g., #security-alerts)
5. Copy the webhook URL (starts with `https://hooks.slack.com/services/...`)

### **3. Test Slack Integration**
```bash
export WEBHOOK_URL="https://hooks.slack.com/services/YOUR/WEBHOOK/HERE"
node forensics/monitor/webhook-test.js
```

## **Discord Integration**

### **1. Create Discord Webhook**
1. Go to your Discord server
2. Right-click the target channel → "Edit Channel"
3. Go to "Integrations" → "Webhooks"
4. Click "Create Webhook"
5. Name: "Specular Monitor"
6. Copy the webhook URL

### **2. Test Discord Integration**
```bash
export WEBHOOK_URL="https://discord.com/api/webhooks/YOUR/WEBHOOK"
node forensics/monitor/webhook-test.js
```

## **Production Monitor with Webhooks**

### **Start with Alerts**
```bash
export WEBHOOK_URL="https://hooks.slack.com/services/YOUR/WEBHOOK"
export POLL_INTERVAL_SEC=300  # 5 minutes
export LOG_LEVEL=INFO
./forensics/monitor/start-monitor.sh start
```

### **Test Alert Delivery**
```bash
# Send test alerts to verify webhook works
WEBHOOK_URL="$WEBHOOK_URL" node forensics/monitor/webhook-test.js
```

## **Alert Severity Levels**

### **🚨 CRITICAL (Red)**
- **B1**: Duplicate poolLenders detected
- **S1**: Fund drain invariant violated
- **S5**: Agent exceeds DoS threshold

### **⚠️ WARNING (Orange)**
- **S5**: Agent approaching DoS threshold (80%+)
- **Network**: RPC connection issues

### **ℹ️ INFO (Green)**
- Monitor startup/shutdown
- Daily health summaries

## **Alert Examples**

### **Slack Alert Format**
```
🚨 Specular Invariant Violation [CRITICAL]

B1 Duplicate Lenders on base-canonical

{
  "network": "base-canonical",
  "violations": [{
    "agentId": 1,
    "duplicates": [{"address": "0x800e305A...", "count": 2}]
  }]
}

Specular Invariant Monitor
```

### **Discord Alert Format**
```
🚨 **Specular Invariant Violation [CRITICAL]**

**S1 Fund Drain on base-canonical**

```json
{
  "actualBalance": "1.500000",
  "claimedTotal": "1.500002",
  "deficit": "0.000002"
}
```

*Specular Invariant Monitor*
```

## **Custom Webhook Formats**

### **Generic HTTP Webhook**
If using a custom endpoint, the monitor sends:

```json
{
  "text": "🚨 Specular Invariant Violation [CRITICAL]",
  "attachments": [{
    "color": "danger",
    "title": "B1 Duplicate Lenders on base-canonical",
    "text": "{\"network\":\"base-canonical\",\"violations\":[...]}",
    "ts": 1778004400,
    "footer": "Specular Invariant Monitor"
  }]
}
```

### **Microsoft Teams**
```bash
# Teams webhook URL format:
export WEBHOOK_URL="https://outlook.office.com/webhook/YOUR-TEAMS-WEBHOOK"
```

## **Production Configuration**

### **Systemd Service with Webhooks**
```ini
# /etc/systemd/system/specular-monitor.service
[Unit]
Description=Specular Invariant Monitor
After=network.target

[Service]
Type=simple
User=monitor
WorkingDirectory=/opt/specular-monitor
Environment=WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK
Environment=BASE_RPC_URL=https://mainnet.base.org
Environment=ARC_TESTNET_RPC_URL=https://arc-testnet.drpc.org
Environment=POLL_INTERVAL_SEC=300
Environment=LOG_LEVEL=INFO
ExecStart=/opt/specular-monitor/forensics/monitor/start-monitor.sh start-service
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
```

### **Docker with Webhooks**
```bash
docker run -d --name specular-monitor \
  -e WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK \
  -e BASE_RPC_URL=https://mainnet.base.org \
  -e ARC_TESTNET_RPC_URL=https://arc-testnet.drpc.org \
  -e POLL_INTERVAL_SEC=300 \
  --restart=unless-stopped \
  specular-monitor
```

## **Alert Management**

### **Mute/Unmute Alerts**
```bash
# Temporarily disable webhooks (logs only)
unset WEBHOOK_URL
./forensics/monitor/start-monitor.sh restart

# Re-enable alerts
export WEBHOOK_URL="https://hooks.slack.com/services/YOUR/WEBHOOK"
./forensics/monitor/start-monitor.sh restart
```

### **Alert Frequency**
- **CRITICAL**: Immediate (every violation detected)
- **WARNING**: Rate limited to 1 per hour per violation type
- **INFO**: Daily summaries only

### **Webhook Failures**
- Monitor continues running even if webhooks fail
- Webhook errors are logged but don't stop monitoring
- Failed webhook attempts are retried once with 5s delay

## **Security Best Practices**

- ⚠️ **Webhook URLs are sensitive** - they allow posting to your channels
- ✅ **Use dedicated channels** for security alerts (e.g., #security-alerts)
- ✅ **Restrict webhook permissions** to posting only
- ✅ **Monitor webhook usage** for unauthorized access
- ✅ **Rotate webhook URLs** periodically

## **Troubleshooting**

### **Webhook not working**
```bash
# Test with curl
curl -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d '{"text":"Test from Specular Monitor"}'

# Check monitor logs
./forensics/monitor/start-monitor.sh logs | grep webhook
```

### **Too many alerts**
```bash
# Increase poll interval to reduce frequency
export POLL_INTERVAL_SEC=900  # 15 minutes
./forensics/monitor/start-monitor.sh restart
```

### **Missing alerts**
```bash
# Check monitor is running
./forensics/monitor/start-monitor.sh status

# Check for violations
./forensics/monitor/start-monitor.sh violations
```