#!/bin/sh

echo "running type tests..."
pnpm run test:types

echo "running browser tests..."
pnpm run test:browser

echo "running e2e tests..."
pnpm run test:e2e
