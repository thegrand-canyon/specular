#!/usr/bin/env bash
# Install the V6 invariant monitor as a launchd agent (macOS) running every 30 min.
#
# Usage:
#   ./forensics/monitor/install-v6-monitor.sh         # install + load
#   ./forensics/monitor/install-v6-monitor.sh uninstall  # unload + remove

set -euo pipefail

PLIST_NAME="com.specular.v6-invariants"
SOURCE_PLIST="$(cd "$(dirname "$0")" && pwd)/${PLIST_NAME}.plist"
TARGET_PLIST="${HOME}/Library/LaunchAgents/${PLIST_NAME}.plist"

case "${1:-install}" in
    install)
        if [[ ! -f "$SOURCE_PLIST" ]]; then
            echo "ERROR: source plist not found at $SOURCE_PLIST"; exit 1
        fi
        mkdir -p "${HOME}/Library/LaunchAgents"
        cp "$SOURCE_PLIST" "$TARGET_PLIST"
        echo "Installed: $TARGET_PLIST"
        # Unload first if already loaded (safe to call when not loaded)
        launchctl unload "$TARGET_PLIST" 2>/dev/null || true
        launchctl load "$TARGET_PLIST"
        echo "Loaded launchd job: $PLIST_NAME (fires every 30 min)"
        echo ""
        echo "Logs:"
        echo "  forensics/monitor/v6-invariants.log         (JSONL — append-only)"
        echo "  forensics/monitor/v6-invariants-stdout.log  (stdout if any)"
        echo "  forensics/monitor/v6-invariants-stderr.log  (stderr / errors)"
        echo ""
        echo "Status:    launchctl list | grep $PLIST_NAME"
        echo "Tail log:  tail -f forensics/monitor/v6-invariants.log"
        ;;
    uninstall)
        if [[ -f "$TARGET_PLIST" ]]; then
            launchctl unload "$TARGET_PLIST" 2>/dev/null || true
            rm "$TARGET_PLIST"
            echo "Uninstalled: $TARGET_PLIST"
        else
            echo "Not installed."
        fi
        ;;
    status)
        launchctl list | grep "$PLIST_NAME" || echo "Not loaded."
        ;;
    *)
        echo "Usage: $0 [install|uninstall|status]" >&2
        exit 1
        ;;
esac
