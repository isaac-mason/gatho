#!/usr/bin/env bash
set -euo pipefail

# start test infrastructure, run e2e tests, tear down
# usage: ./e2e.sh

cleanup() {
    echo "stopping docker compose..."
    docker compose down
}
trap cleanup EXIT

echo "starting docker compose..."
docker compose up -d --wait

echo "running e2e tests..."
pnpm vitest run e2e

echo "done."
