#!/usr/bin/env bash
# Starts the AgentNet host daemon for ToyKind-Operator-1.
# This runs on the NanoClaw HOST so the daemon persists across container restarts.
# Called from src/index.ts main() at NanoClaw startup.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTNET_DATA_DIR="$SCRIPT_DIR/.agentnet"
AGENTNET_BIN="$AGENTNET_DATA_DIR/bin/agentnet"
AGENTNET_RELAY="wss://agentnet.toykind.world/v1/ws"
AGENTNET_NAME="ToyKind-Operator-1"
AGENTNET_LOG="$AGENTNET_DATA_DIR/daemon.log"
AGENTNET_PID="$AGENTNET_DATA_DIR/daemon.pid"
DESTINATIONS_FILE="$SCRIPT_DIR/groups/feishu_main/ACTIVE_DESTINATIONS.md"

# Kill any existing daemon
if [ -f "$AGENTNET_PID" ]; then
  OLD_PID=$(cat "$AGENTNET_PID")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[agentnet] Stopping existing daemon (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
fi

# Bind to 0.0.0.0 so Docker containers can reach via host.docker.internal
AGENTNET_API_ADDR="0.0.0.0:9900"

# Start daemon
echo "[agentnet] Starting daemon as $AGENTNET_NAME..."
AGENTNET_DATA_DIR="$AGENTNET_DATA_DIR" \
AGENTNET_RELAY="$AGENTNET_RELAY" \
AGENTNET_NAME="$AGENTNET_NAME" \
AGENTNET_API="$AGENTNET_API_ADDR" \
nohup "$AGENTNET_BIN" daemon >> "$AGENTNET_LOG" 2>&1 &
echo $! > "$AGENTNET_PID"
echo "[agentnet] Daemon started (PID $(cat $AGENTNET_PID))"

sleep 3

# Verify connection
STATUS=$(AGENTNET_DATA_DIR="$AGENTNET_DATA_DIR" "$AGENTNET_BIN" status 2>&1)
echo "[agentnet] Status: $STATUS"

# Join or create all active rooms from ACTIVE_DESTINATIONS.md
if [ -f "$DESTINATIONS_FILE" ]; then
  echo "[agentnet] Reading destinations from $DESTINATIONS_FILE..."
  # Parse markdown table: extract rows where Status column is "active"
  while IFS='|' read -r _ room_name display_name _ status _; do
    room_name=$(echo "$room_name" | xargs)
    display_name=$(echo "$display_name" | xargs)
    status=$(echo "$status" | xargs)
    # Skip header, separator, and inactive rows
    [ -z "$room_name" ] && continue
    [[ "$room_name" == "Room Name" ]] && continue
    [[ "$room_name" == ---* ]] && continue
    [[ "$status" != "active" ]] && continue

    echo "[agentnet] Ensuring room '$room_name' ($display_name)..."
    AGENTNET_DATA_DIR="$AGENTNET_DATA_DIR" "$AGENTNET_BIN" create "$room_name" "$display_name" 2>/dev/null \
      || AGENTNET_DATA_DIR="$AGENTNET_DATA_DIR" "$AGENTNET_BIN" join "$room_name" 2>/dev/null \
      || echo "[agentnet]   Already a member of '$room_name'"
  done < "$DESTINATIONS_FILE"
else
  echo "[agentnet] WARNING: Destinations file not found at $DESTINATIONS_FILE"
fi

echo "[agentnet] Host daemon ready."
