#!/bin/sh

# typescript type check
pnpm tsc --noEmit

# run type tests
pnpm vitest run types
