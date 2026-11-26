#!/usr/bin/env bash
# The pipeline's only configured step: upload the steps from the repository.
set -euo pipefail
buildkite-agent pipeline upload .buildkite/pipeline.yml
