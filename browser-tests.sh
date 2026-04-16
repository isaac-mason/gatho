#!/usr/bin/env bash
set -euo pipefail

# build client bundle, run browser (playwright) tests
# usage: ./browser-tests.sh

echo "building client bundle..."
pnpm build

echo "running browser tests..."
pnpm playwright test

echo "done."
