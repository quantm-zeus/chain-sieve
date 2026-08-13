#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi

repo="${CHAINSIEVE_REPO_PATH:-/srv/chainsieve/repo}"
test -d "$repo/.git" || { echo "repository checkout not found at $repo" >&2; exit 1; }
ao_ref="b48c98c94ca0039ad1bc42bd1b78134d3ff5773d"
ao_source="/opt/chainsieve/vendor/agent-orchestrator"
spec_kit_ref="4871b485f97c7fa452ec58eba325d87536c55c34"
muse_version="Muse Code 0.1.0 (0.1.0-R708.1)"
agy_version="1.1.12"
muse_source="${CHAINSIEVE_MUSE_SOURCE:-}"
agy_source="${CHAINSIEVE_AGY_SOURCE:-}"
muse_sha256="${CHAINSIEVE_MUSE_SHA256:-}"
agy_sha256="${CHAINSIEVE_AGY_SHA256:-}"

for command in git go python3.12 gh tmux uv node pnpm; do
  command -v "$command" >/dev/null || { echo "missing prerequisite: $command" >&2; exit 1; }
done
test "$(python3.12 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')" = "3.12" || {
  echo "Python 3.12 is required" >&2
  exit 1
}
[[ "$(node --version)" == v22.* ]] || { echo "Node 22 is required" >&2; exit 1; }
test "$(pnpm --version)" = "10.13.1" || { echo "pnpm 10.13.1 is required" >&2; exit 1; }

test "$(go version | awk '{print $3}')" = "go1.25.7" || {
  echo "Go 1.25.7 is required to reproduce the pinned AO build" >&2
  exit 1
}
if [[ -z "$muse_source" || ! -x "$muse_source" ]]; then
  echo "set CHAINSIEVE_MUSE_SOURCE to the executable Muse $muse_version Linux release binary" >&2
  exit 1
fi
if [[ -z "$agy_source" || ! -x "$agy_source" ]]; then
  echo "set CHAINSIEVE_AGY_SOURCE to the executable Antigravity $agy_version Linux release binary" >&2
  exit 1
fi
[[ "$muse_sha256" =~ ^[0-9a-f]{64}$ ]] || { echo "set CHAINSIEVE_MUSE_SHA256 to the verified Linux binary SHA-256" >&2; exit 1; }
[[ "$agy_sha256" =~ ^[0-9a-f]{64}$ ]] || { echo "set CHAINSIEVE_AGY_SHA256 to the verified Linux binary SHA-256" >&2; exit 1; }
echo "$muse_sha256  $muse_source" | sha256sum --check --status
echo "$agy_sha256  $agy_source" | sha256sum --check --status
MUSE_NO_AUTO_UPDATE=1 "$muse_source" --version | grep -Fx "$muse_version" >/dev/null
"$agy_source" --version | grep -Fx "$agy_version" >/dev/null

getent group chainsieve >/dev/null || groupadd --system chainsieve
getent group chainsieve-worker >/dev/null || groupadd --system chainsieve-worker
getent group chainsieve-controller >/dev/null || groupadd --system chainsieve-controller
id chainsieve-worker >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/chainsieve-worker --gid chainsieve-worker --groups chainsieve --shell /usr/sbin/nologin chainsieve-worker
id chainsieve-controller >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/chainsieve-controller --gid chainsieve-controller --groups chainsieve --shell /usr/sbin/nologin chainsieve-controller

# AO needs Git's administrative directory to create isolated worktrees and
# branch refs. Product source in the root checkout remains non-writable.
chgrp -R chainsieve-worker "$repo/.git"
chmod -R g+rwX "$repo/.git"
find "$repo/.git" -type d -exec chmod g+s '{}' \;
runuser -u chainsieve-worker -- test -w "$repo/.git"

install -d -o root -g chainsieve -m 0750 /etc/chainsieve /opt/chainsieve/vendor /opt/chainsieve/factory-bin
install -d -o root -g chainsieve -m 0755 /usr/local/lib/chainsieve/providers
install -d -o chainsieve-worker -g chainsieve -m 0750 /var/lib/chainsieve/ao /var/lib/chainsieve/worktrees
install -d -o chainsieve-controller -g chainsieve -m 0750 /var/lib/chainsieve/factory
install -d -o root -g chainsieve -m 0755 /srv/chainsieve
python3.12 -m venv --clear /srv/chainsieve/.venv
chown -R root:chainsieve /srv/chainsieve/.venv
chmod -R go-w /srv/chainsieve/.venv
/srv/chainsieve/.venv/bin/python - <<'PY'
import pathlib
import sys
import tomllib

root = pathlib.Path("/srv/chainsieve/repo")
project = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
assert project["project"]["requires-python"] == ">=3.12,<3.13"
assert project["project"]["dependencies"] == []
assert sys.version_info[:2] == (3, 12)
assert not [line for line in (root / "factory/requirements.lock").read_text().splitlines() if line.strip() and not line.lstrip().startswith("#")]
PY

if [[ ! -d "$ao_source/.git" ]]; then
  git clone https://github.com/Untrivial-ai/agent-orchestrator.git "$ao_source"
fi
git -C "$ao_source" fetch --tags origin
git -C "$ao_source" checkout --detach "$ao_ref"
test "$(git -C "$ao_source" rev-parse HEAD)" = "$ao_ref"
(
  cd "$ao_source/backend"
  # v0.12.3's unrelated fake-agent lifecycle test uses `sh -lc`, which
  # overwrites its injected PATH on Debian/Ubuntu and cannot find its test shim.
  # Run the complete production-relevant surface instead of hiding failures.
  go test \
    ./internal/adapters/agent/muse \
    ./internal/adapters/agent/agy \
    ./internal/adapters/reviewer/muse \
    ./internal/adapters/reviewer/agy \
    ./internal/adapters/runtime/tmux \
    ./internal/adapters/scm/github \
    ./internal/adapters/tracker/github \
    ./internal/adapters/workspace/gitworktree \
    ./internal/cli \
    ./internal/daemon/... \
    ./internal/httpd/controllers \
    ./internal/review/... \
    ./internal/service/session \
    ./internal/session_manager \
    ./internal/storage/sqlite/...
  go build -trimpath \
    -ldflags "-s -w -X github.com/aoagents/agent-orchestrator/backend/internal/cli.Version=0.12.3 -X github.com/aoagents/agent-orchestrator/backend/internal/cli.Commit=$ao_ref" \
    -o /usr/local/bin/ao ./cmd/ao
)
ao version | grep -F "0.12.3" >/dev/null

UV_TOOL_DIR=/opt/chainsieve/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin \
  uv tool install specify-cli --force --from "git+https://github.com/github/spec-kit.git@${spec_kit_ref}"
specify --version | grep -F "0.16.2" >/dev/null

install -o root -g chainsieve -m 0755 "$muse_source" /usr/local/lib/chainsieve/providers/muse
install -o root -g chainsieve -m 0755 "$agy_source" /usr/local/lib/chainsieve/providers/agy
install -o root -g chainsieve -m 0755 "$repo/factory/deployment/bin/muse" /opt/chainsieve/factory-bin/muse
install -o root -g chainsieve -m 0755 "$repo/factory/deployment/bin/agy" /opt/chainsieve/factory-bin/agy
MUSE_NO_AUTO_UPDATE=1 /opt/chainsieve/factory-bin/muse --version | grep -Fx "$muse_version" >/dev/null
/opt/chainsieve/factory-bin/agy --version | grep -Fx "$agy_version" >/dev/null
install -o root -g root -m 0644 "$repo/factory/deployment/systemd/chainsieve-ao.service" /etc/systemd/system/chainsieve-ao.service
install -o root -g root -m 0644 "$repo/factory/deployment/systemd/chainsieve-factory.service" /etc/systemd/system/chainsieve-factory.service
install -o root -g root -m 0644 "$repo/factory/deployment/systemd/chainsieve-reboot-probe.service" /etc/systemd/system/chainsieve-reboot-probe.service
install -o root -g root -m 0644 "$repo/factory/deployment/logrotate/chainsieve-factory" /etc/logrotate.d/chainsieve-factory

if [[ ! -e /etc/chainsieve/ao.env ]]; then
  install -o chainsieve-worker -g root -m 0600 "$repo/factory/deployment/env/ao.env.example" /etc/chainsieve/ao.env
fi
if [[ ! -e /etc/chainsieve/factory.env ]]; then
  install -o chainsieve-controller -g root -m 0600 "$repo/factory/deployment/env/factory.env.example" /etc/chainsieve/factory.env
fi

systemctl daemon-reload
systemctl enable chainsieve-ao.service chainsieve-factory.service chainsieve-reboot-probe.service
systemctl start chainsieve-ao.service

export AO_RUN_FILE=/run/chainsieve-ao/running.json
if ! runuser -u chainsieve-worker -- env AO_RUN_FILE="$AO_RUN_FILE" HOME=/var/lib/chainsieve-worker /usr/local/bin/ao project get chainsieve --json >/dev/null 2>&1; then
  runuser -u chainsieve-worker -- env AO_RUN_FILE="$AO_RUN_FILE" HOME=/var/lib/chainsieve-worker /usr/local/bin/ao project add --path "$repo" --id chainsieve --name ChainSieve --worker-agent muse
fi
config_json="$(tr -d '\n' < "$repo/factory/deployment/ao-project-config.json")"
runuser -u chainsieve-worker -- env AO_RUN_FILE="$AO_RUN_FILE" HOME=/var/lib/chainsieve-worker /usr/local/bin/ao project set-config chainsieve --config-json "$config_json"

if ! runuser -u chainsieve-worker -- env AO_RUN_FILE="$AO_RUN_FILE" HOME=/var/lib/chainsieve-worker /usr/local/bin/ao project get chainsieve-canary --json >/dev/null 2>&1; then
  runuser -u chainsieve-worker -- env AO_RUN_FILE="$AO_RUN_FILE" HOME=/var/lib/chainsieve-worker /usr/local/bin/ao project add --path "$repo" --id chainsieve-canary --name ChainSieve-Canary --worker-agent muse
fi
canary_config_json="$(tr -d '\n' < "$repo/factory/deployment/ao-canary-project-config.json")"
runuser -u chainsieve-worker -- env AO_RUN_FILE="$AO_RUN_FILE" HOME=/var/lib/chainsieve-worker /usr/local/bin/ao project set-config chainsieve-canary --config-json "$canary_config_json"

echo "Installation complete. Populate /etc/chainsieve/ao.env and /etc/chainsieve/factory.env, run factory doctor, then start chainsieve-factory.service."
