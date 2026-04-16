#!/usr/bin/env bash

# start the ha example:
# — redis + 3 caddy reverse proxies (docker compose)
# — 3 gatho servers (each runs rooms/src/server.ts, fronted by its own caddy)
# — backend api
# — frontend

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GATHO_REDIS_URL="redis://localhost:6379"

cleanup() {
    echo ""
    echo "  shutting down..."
    kill $PID1 $PID2 $PID3 $PID_API $PID_VITE 2>/dev/null
    wait $PID1 $PID2 $PID3 $PID_API $PID_VITE 2>/dev/null
    docker compose -f "$SCRIPT_DIR/docker-compose.yml" down
    echo "  done"
}

trap cleanup EXIT INT TERM

echo ""
echo "  gatho ha example"
echo ""

# start redis + caddy instances
echo "  starting redis + caddy..."
docker compose -f "$SCRIPT_DIR/docker-compose.yml" up -d
echo ""

# gatho server 1 — caddy on :8001, health on :3001
GATHO_REDIS_URL="$GATHO_REDIS_URL" \
GATHO_CADDY_PORT=8001 \
GATHO_PORT=3001 \
bun "$SCRIPT_DIR/rooms/src/server.ts" &
PID1=$!

# gatho server 2 — caddy on :8002, health on :3002
GATHO_REDIS_URL="$GATHO_REDIS_URL" \
GATHO_CADDY_PORT=8002 \
GATHO_PORT=3002 \
bun "$SCRIPT_DIR/rooms/src/server.ts" &
PID2=$!

# gatho server 3 — caddy on :8003, health on :3003
GATHO_REDIS_URL="$GATHO_REDIS_URL" \
GATHO_CADDY_PORT=8003 \
GATHO_PORT=3003 \
bun "$SCRIPT_DIR/rooms/src/server.ts" &
PID3=$!

# backend api — port 4000
GATHO_REDIS_URL="$GATHO_REDIS_URL" bun "$SCRIPT_DIR/backend/src/server.ts" &
PID_API=$!

# frontend — port 5190
cd "$SCRIPT_DIR/frontend" && pnpm dev --port 5190 --host &
PID_VITE=$!

echo ""
echo "  servers:"
echo "    gatho-1    caddy :8001 -> rooms (health :3001)"
echo "    gatho-2    caddy :8002 -> rooms (health :3002)"
echo "    gatho-3    caddy :8003 -> rooms (health :3003)"
echo "    api        http://localhost:4000"
echo "    frontend   http://localhost:5190"
echo ""

wait
