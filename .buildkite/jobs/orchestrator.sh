#!/usr/bin/env bash
set -euo pipefail
export CI=true
# The Rust orchestrator (orchestrator/). Its tests run TypeScript through node for compatibility checks.
export PATH="/opt/gespann-ci/node24/bin:/usr/local/bin:${HOME}/.cargo/bin:${PATH}"
cd "$(git rev-parse --show-toplevel)"
echo "--- toolchain"
cargo --version
node --version
echo "+++ clippy"
cargo clippy --manifest-path orchestrator/Cargo.toml --all-targets --locked -- -D warnings
echo "+++ tests"
cargo test --manifest-path orchestrator/Cargo.toml --locked
