#!/bin/bash

# Install Automated Moltbook Posting Cron Job
# Runs Monday/Wednesday/Friday at 10 AM

echo "═══════════════════════════════════════"
echo "  Installing Moltbook Posting Cron Job"
echo "═══════════════════════════════════════"
echo ""

# Get absolute paths
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
NODE_PATH="/opt/homebrew/opt/node@22/bin/node"
# Load API key from .env if not set
if [ -z "$MOLTBOOK_API_KEY" ] && [ -f "$PROJECT_DIR/.env" ]; then
    export $(grep "^MOLTBOOK_API_KEY=" "$PROJECT_DIR/.env" | xargs)
fi

if [ -z "$MOLTBOOK_API_KEY" ]; then
    echo "❌ Error: MOLTBOOK_API_KEY not set"
    echo "   Set it in .env or as environment variable"
    exit 1
fi

echo "Project directory: $PROJECT_DIR"
echo "Node path: $NODE_PATH"
echo "Moltbook script: src/moltbook/automated-posting-schedule.js"
echo ""

# Create the cron job line
CRON_LINE="0 10 * * 1,3,5 cd $PROJECT_DIR && MOLTBOOK_API_KEY='$MOLTBOOK_API_KEY' $NODE_PATH src/moltbook/automated-posting-schedule.js >> /tmp/moltbook-posts.log 2>&1"

echo "Cron job to install:"
echo "$CRON_LINE"
echo ""

# Check if cron job already exists
if crontab -l 2>/dev/null | grep -q "automated-posting-schedule.js"; then
    echo "⚠️  Cron job already exists!"
    echo ""
    echo "Current crontab:"
    crontab -l | grep "automated-posting-schedule.js"
    echo ""
    read -p "Replace it? (y/n) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "❌ Cancelled"
        exit 1
    fi

    # Remove old cron job
    crontab -l | grep -v "automated-posting-schedule.js" | crontab -
    echo "✅ Removed old cron job"
fi

# Add new cron job
(crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -

echo ""
echo "✅ Cron job installed successfully!"
echo ""
echo "Schedule: Monday, Wednesday, Friday at 10:00 AM"
echo "Log file: /tmp/moltbook-posts.log"
echo ""
echo "To view current crontab:"
echo "  crontab -l"
echo ""
echo "To view logs:"
echo "  tail -f /tmp/moltbook-posts.log"
echo ""
echo "To test manually:"
echo "  MOLTBOOK_API_KEY='$MOLTBOOK_API_KEY' $NODE_PATH $PROJECT_DIR/src/moltbook/automated-posting-schedule.js"
echo ""
