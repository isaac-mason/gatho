#!/usr/bin/env bash
set -euo pipefail

# build client bundle, run browser (playwright) tests
# usage: ./browser.sh

echo "running browser tests..."
pnpm playwright test

echo "done."
