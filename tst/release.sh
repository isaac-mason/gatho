#!/bin/sh

echo "running unit tests..."
pnpm test:unit

echo "running browser tests...
pnpm test:browser

echo "running e2e tests..."
pnpm test:e2e
