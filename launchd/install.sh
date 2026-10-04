#!/bin/sh
# Installs the decider as a per-user LaunchAgent: one shared server on 127.0.0.1:8765 for every session.
set -e
dest="$HOME/Library/LaunchAgents/dev.sieve.decider.plist"
sed "s#__HOME__#$HOME#g" "$(dirname "$0")/dev.sieve.decider.plist" > "$dest"
launchctl bootout "gui/$(id -u)/dev.sieve.decider" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$dest"
echo "installed; log: $HOME/Library/Logs/sieve-decider.log"
