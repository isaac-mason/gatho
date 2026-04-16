#!/bin/sh

echo "running unit tests..."
pnpm run test:unit

echo "running integration tests..."
pnpm run test:integration

echo "running type tests..."
pnpm run test:types

echo "running playwright browser tests..."
pnpm run test:browser

echo "running e2e tests..."
pnpm run test:e2e
