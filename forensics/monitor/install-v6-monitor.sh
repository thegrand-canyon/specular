#!/usr/bin/env bash
# Install / uninstall the Specular monitoring launchd agents (macOS).
#
# [2026-09-24] This script used to install ONE plist — `com.specular.v6-invariants.plist`,
# an arc-TESTNET job that ran the bare monitor with no alert wrapper and was deliberately
# disabled on this machine. Running it resurrected a retired job pointed at a retired stack,
# and (because a retired job's heartbeat file keeps triggering the dead-man's switch) it
# could restart the every-30-minutes MONITOR_DOWN alert storm. It now installs the jobs that
# are ACTUALLY meant to run, and nothing else.
#
# Four of the five jobs that were running on 2026-09-24 existed only in ~/Library/LaunchAgents
# and in no git history at all — lose the machine and you lose the monitoring. The plists now
# live beside this script, so `install` is a real rebuild step.
#
# Usage:
#   ./forensics/monitor/install-v6-monitor.sh            # install + load every job
#   ./forensics/monitor/install-v6-monitor.sh status     # what is loaded
#   ./forensics/monitor/install-v6-monitor.sh uninstall  # unload + remove every job
#
# After `install`, verify the alert path is real before trusting it:
#   node forensics/monitor/alert.js --self-test
#   node forensics/monitor/alert.js --status     # every job must have a fresh heartbeat
#
# Notes:
#   * The plists hardcode /Users/peterschroeder/Specular. On a rebuilt machine with a
#     different path, edit them (SPECULAR_REPO, ProgramArguments, StandardOutPath,
#     WorkingDirectory) before installing.
#   * Webhook URL, if any, goes in forensics/monitor/monitor.env (gitignored) — never a plist.
#   * If you REMOVE a job, delete its heartbeat file too
#     (forensics/monitor/heartbeat-<instance>.json); otherwise every surviving monitor
#     raises MONITOR_DOWN about it every 30 minutes, for ever.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LA="${HOME}/Library/LaunchAgents"

# The jobs that are meant to run. `com.specular.v6-invariants` (arc-testnet) is intentionally
# NOT in this list: that deployment is retired.
JOBS=(
    com.specular.v6-invariants-arc-mainnet          # canonical V6.2 + V4 stack, every 30 min
    com.specular.v6-invariants-arc-mainnet-legacy   # superseded V6.1 marketplace, every 30 min
    com.specular.v6-invariants-arc-staging          # staging stack, every 30 min
    com.specular.overdue-loans-arc-mainnet          # liquidation candidates, hourly
    com.specular.rpc-health-sample                  # hosted-API upstream RPC health, every 15 min
)

case "${1:-install}" in
    install)
        mkdir -p "$LA"
        for j in "${JOBS[@]}"; do
            src="$HERE/${j}.plist"
            dst="$LA/${j}.plist"
            if [[ ! -f "$src" ]]; then echo "ERROR: missing $src"; exit 1; fi
            cp "$src" "$dst"
            launchctl unload "$dst" 2>/dev/null || true
            launchctl load "$dst"
            echo "loaded  $j"
        done
        echo
        echo "Verify:"
        echo "  launchctl list | grep specular"
        echo "  node forensics/monitor/alert.js --status     # every job must have a fresh heartbeat"
        echo "  node forensics/monitor/alert.js --self-test  # prove the channels still work"
        ;;
    uninstall)
        for j in "${JOBS[@]}"; do
            dst="$LA/${j}.plist"
            if [[ -f "$dst" ]]; then
                launchctl unload "$dst" 2>/dev/null || true
                rm "$dst"
                echo "removed $j"
            fi
        done
        echo
        echo "Also delete the heartbeat files of the jobs you removed, or the dead-man's"
        echo "switch will alert about them for ever:  rm forensics/monitor/heartbeat-*.json"
        ;;
    status)
        launchctl list | grep specular || echo "No Specular jobs loaded."
        ;;
    *)
        echo "Usage: $0 [install|uninstall|status]" >&2
        exit 1
        ;;
esac
