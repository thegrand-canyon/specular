#!/bin/bash
# Real-time Load Test Monitor
# Usage: ./scripts/monitor-load-test.sh

echo "📊 LOAD TEST MONITOR - Refreshing every 5 seconds"
echo "Press Ctrl+C to stop"
echo ""

while true; do
    clear
    echo "═══════════════════════════════════════════════════════"
    echo "📊 LOAD TEST PROGRESS - $(date)"
    echo "═══════════════════════════════════════════════════════"
    echo ""

    # Show last 50 lines
    tail -50 /tmp/claude/-Users-peterschroeder/tasks/b477619.output

    echo ""
    echo "═══════════════════════════════════════════════════════"
    echo "Refreshing in 5 seconds..."

    sleep 5
done
