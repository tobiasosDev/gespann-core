#!/usr/bin/env bash
set -euo pipefail
export CI=true
# Node 24, as in the Dockerfile. The agent puts it in /opt/gespann-ci/node24.
export PATH="/opt/gespann-ci/node24/bin:${PATH}"
cd "$(git rev-parse --show-toplevel)"
echo "--- toolchain"
echo "node $(node --version), npm $(npm --version)"
echo "--- npm ci"
npm ci --no-audit --no-fund
echo "+++ audit (runtime dependencies)"
npm audit --omit=dev --audit-level=high
echo "+++ lint"
npm run lint
echo "+++ typecheck"
npm run typecheck
echo "+++ tests"
npm test
echo "+++ build"
npm run build
echo "+++ built CLI prints the package version"
test "$(node dist/bin.js --version)" = "$(node -p "require('./package.json').version")"
