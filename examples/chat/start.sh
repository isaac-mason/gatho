#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"

# start gatho server + api (onebox)
echo "starting server..."
cd "$DIR/backend"
pnpm start &
SERVER_PID=$!

# start frontend
echo "starting frontend..."
cd "$DIR/frontend"
pnpm dev &
VITE_PID=$!

# cleanup on exit
cleanup() {
    echo ""
    echo "shutting down..."
    kill $SERVER_PID 2>/dev/null || true
    kill $VITE_PID 2>/dev/null || true
    wait
}
trap cleanup EXIT INT TERM

wait
