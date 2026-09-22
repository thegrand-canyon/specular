#!/bin/bash
# Specular Invariant Monitor Production Startup Script

set -e

# Configuration
LOG_DIR="/tmp/specular-monitor-logs"
PID_FILE="/tmp/specular-monitor.pid"
LOG_FILE="$LOG_DIR/monitor-$(date +%Y%m%d-%H%M%S).log"

# Default environment
export BASE_RPC_URL="${BASE_RPC_URL:-https://mainnet.base.org}"
export ARC_TESTNET_RPC_URL="${ARC_TESTNET_RPC_URL:-https://arc-testnet.drpc.org}"
export LOG_LEVEL="${LOG_LEVEL:-INFO}"
export POLL_INTERVAL_SEC="${POLL_INTERVAL_SEC:-300}"  # 5 minute default

# Create log directory
mkdir -p "$LOG_DIR"

# Function to check if monitor is running
is_running() {
    [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

# Function to stop monitor
stop_monitor() {
    if is_running; then
        echo "Stopping Specular monitor (PID: $(cat "$PID_FILE"))..."
        kill "$(cat "$PID_FILE")"
        rm -f "$PID_FILE"
        echo "Monitor stopped."
    else
        echo "Monitor is not running."
    fi
}

# Function to start monitor
start_monitor() {
    if is_running; then
        echo "Monitor is already running (PID: $(cat "$PID_FILE"))"
        return 1
    fi

    echo "Starting Specular Invariant Monitor..."
    echo "  Base RPC: $BASE_RPC_URL"
    echo "  Arc RPC: $ARC_TESTNET_RPC_URL"
    echo "  Poll interval: ${POLL_INTERVAL_SEC}s"
    echo "  Log file: $LOG_FILE"

    # Start in background and save PID
    nohup node "$(dirname "$0")/invariant-monitor.js" > "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"

    # Wait a moment and check if it started successfully
    sleep 2
    if is_running; then
        echo "✅ Monitor started successfully (PID: $(cat "$PID_FILE"))"
        echo "📊 Real-time log: tail -f $LOG_FILE"
        echo "🔍 Status check: $0 status"
    else
        echo "❌ Failed to start monitor. Check log: $LOG_FILE"
        return 1
    fi
}

# Function to show status
show_status() {
    if is_running; then
        PID=$(cat "$PID_FILE")
        echo "✅ Monitor is running (PID: $PID)"
        echo "📊 Latest logs:"
        tail -n 5 "$(ls -t "$LOG_DIR"/monitor-*.log | head -1)" 2>/dev/null || echo "No logs yet"
    else
        echo "❌ Monitor is not running"
    fi
}

# Function to show live logs
show_logs() {
    local latest_log=$(ls -t "$LOG_DIR"/monitor-*.log 2>/dev/null | head -1)
    if [ -n "$latest_log" ]; then
        echo "📊 Showing live logs from: $latest_log"
        echo "Press Ctrl+C to exit"
        tail -f "$latest_log"
    else
        echo "No log files found in $LOG_DIR"
    fi
}

# Function to show recent violations
show_violations() {
    local latest_log=$(ls -t "$LOG_DIR"/monitor-*.log 2>/dev/null | head -1)
    if [ -n "$latest_log" ]; then
        echo "🚨 Recent invariant violations:"
        grep -E '"level":"(ERROR|WARN)"' "$latest_log" | tail -10 | while read line; do
            echo "  $line"
        done
    else
        echo "No log files found"
    fi
}

# Main command dispatch
case "${1:-start}" in
    start)
        start_monitor
        ;;
    stop)
        stop_monitor
        ;;
    restart)
        stop_monitor
        sleep 1
        start_monitor
        ;;
    status)
        show_status
        ;;
    logs)
        show_logs
        ;;
    violations)
        show_violations
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|logs|violations}"
        echo ""
        echo "Commands:"
        echo "  start      - Start the monitor"
        echo "  stop       - Stop the monitor"
        echo "  restart    - Restart the monitor"
        echo "  status     - Show current status"
        echo "  logs       - Show live logs"
        echo "  violations - Show recent violations"
        echo ""
        echo "Environment variables:"
        echo "  BASE_RPC_URL       - Base mainnet RPC endpoint"
        echo "  ARC_TESTNET_RPC_URL - Arc testnet RPC endpoint"
        echo "  WEBHOOK_URL        - Slack/Discord webhook for alerts"
        echo "  POLL_INTERVAL_SEC  - Seconds between scans (default: 300)"
        echo "  LOG_LEVEL         - DEBUG|INFO|WARN|ERROR (default: INFO)"
        exit 1
        ;;
esac