#!/usr/bin/env bash
set -euo pipefail

deployment_config="${CHAINSIEVE_DEPLOYMENT_CONFIG:-/etc/chainsieve/deployment.env}"
if [[ -r "$deployment_config" ]]; then
  . "$deployment_config"
  export HOME="$CHAINSIEVE_USER_HOME"
  export PYTHONPATH="$CHAINSIEVE_REPO_PATH"
  export CHAINSIEVE_FACTORY_STATE_DIR
  export CHAINSIEVE_FACTORY_PLAN="$CHAINSIEVE_REPO_PATH/specs/factory/current-milestone.json"
  export CHAINSIEVE_FACTORY_EXPECTED_PYTHON="$CHAINSIEVE_FACTORY_PYTHON"
  cd "$CHAINSIEVE_REPO_PATH"
  exec "$CHAINSIEVE_FACTORY_PYTHON" -m factory "$@"
fi

exec python3 -m factory "$@"
