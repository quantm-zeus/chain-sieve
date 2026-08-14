#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: sudo $0 --user USER --repo PATH [--state PATH] [--ao-data PATH] [--venv PATH] [--gh-bin PATH] [--muse-bin PATH] [--agy-bin PATH] [--codex-bin PATH]" >&2
}

[[ "$(id -u)" -eq 0 ]] || { echo "run as root with sudo" >&2; exit 1; }
[[ -r /etc/os-release ]] || { echo "Linux distribution metadata is unavailable" >&2; exit 1; }
. /etc/os-release
[[ "${ID:-}" == ubuntu ]] || { echo "this installer supports Ubuntu only" >&2; exit 1; }
[[ "$(uname -m)" == x86_64 ]] || { echo "this installer currently supports Ubuntu x86-64 only" >&2; exit 1; }

deploy_user=""
repo=""
state=""
ao_data=""
venv=""
gh_override=""
muse_override=""
agy_override=""
codex_override=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) deploy_user="${2:-}"; shift 2 ;;
    --repo) repo="${2:-}"; shift 2 ;;
    --state) state="${2:-}"; shift 2 ;;
    --ao-data) ao_data="${2:-}"; shift 2 ;;
    --venv) venv="${2:-}"; shift 2 ;;
    --gh-bin) gh_override="${2:-}"; shift 2 ;;
    --muse-bin) muse_override="${2:-}"; shift 2 ;;
    --agy-bin) agy_override="${2:-}"; shift 2 ;;
    --codex-bin) codex_override="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

if [[ -z "$deploy_user" && -n "${SUDO_USER:-}" && "$SUDO_USER" != root ]]; then
  deploy_user="$SUDO_USER"
fi
[[ -n "$deploy_user" && -n "$repo" ]] || { usage; exit 2; }
getent passwd "$deploy_user" >/dev/null || { echo "deployment user does not exist: $deploy_user" >&2; exit 1; }
[[ "$(id -u "$deploy_user")" -ne 0 ]] || { echo "deployment user must be non-root" >&2; exit 1; }
user_home="$(getent passwd "$deploy_user" | cut -d: -f6)"
deploy_group="$(id -gn "$deploy_user")"
[[ -n "$user_home" && "$user_home" == /* && -d "$user_home" ]] || { echo "deployment user has no usable home" >&2; exit 1; }
repo="$(readlink -f "$repo")"
[[ -d "$repo/.git" ]] || { echo "repository checkout not found at $repo" >&2; exit 1; }
runuser -u "$deploy_user" -- git -C "$repo" rev-parse --is-inside-work-tree >/dev/null || {
  echo "deployment user cannot read the repository checkout: $repo" >&2; exit 1;
}
runuser -u "$deploy_user" -- test -w "$repo/.git" || {
  echo "deployment user must own or be able to write the root checkout Git metadata: $repo/.git" >&2; exit 1;
}
state="$(readlink -m "${state:-$user_home/.local/state/chainsieve-factory}")"
ao_data="$(readlink -m "${ao_data:-$user_home/.local/state/agent-orchestrator}")"
venv="$(readlink -m "${venv:-$user_home/.local/share/chainsieve-factory/venv}")"

for value in "$repo" "$state" "$ao_data" "$venv" "$user_home"; do
  [[ "$value" != *$'\n'* ]] || { echo "configured paths cannot contain newlines" >&2; exit 1; }
  [[ "$value" != *[[:space:]\\\"%]* ]] || {
    echo "configured paths cannot contain whitespace, backslash, quote, or percent characters: $value" >&2; exit 1;
  }
done
for value in "$state" "$ao_data" "$venv"; do
  case "$value/" in
    "$repo/"*) echo "runtime and environment paths must be outside the read-only repository: $value" >&2; exit 1 ;;
  esac
  case "$repo/" in
    "$value/"*) echo "runtime and environment paths cannot contain the repository checkout: $value" >&2; exit 1 ;;
  esac
done
for value in "$state" "$ao_data" "$venv"; do
  case "$value" in
    /|/home|/var|/usr|/opt|/etc|"$user_home")
      echo "refusing broad runtime or environment path: $value" >&2
      exit 1
      ;;
  esac
done
runtime_paths=("$state" "$ao_data" "$venv")
for ((left = 0; left < ${#runtime_paths[@]}; left++)); do
  for ((right = left + 1; right < ${#runtime_paths[@]}; right++)); do
    left_path="${runtime_paths[$left]}"
    right_path="${runtime_paths[$right]}"
    if [[ "$left_path" == "$right_path" ]]; then
      echo "factory state, AO data, and venv must use distinct directories: $left_path" >&2
      exit 1
    fi
    case "$left_path/" in
      "$right_path/"*) echo "runtime and environment paths cannot contain one another: $right_path -> $left_path" >&2; exit 1 ;;
    esac
    case "$right_path/" in
      "$left_path/"*) echo "runtime and environment paths cannot contain one another: $left_path -> $right_path" >&2; exit 1 ;;
    esac
  done
done
for service in chainsieve-ao.service chainsieve-factory.service; do
  systemctl is-active --quiet "$service" && { echo "stop $service before reinstalling" >&2; exit 1; }
done

ao_ref="b48c98c94ca0039ad1bc42bd1b78134d3ff5773d"
ao_tree="ea4d7ee451ca5a529422df66fa97a59af2c33a43"
ao_source="/opt/chainsieve/vendor/agent-orchestrator"
spec_kit_ref="4871b485f97c7fa452ec58eba325d87536c55c34"
for command in git go python3.12 tmux uv node pnpm systemd-analyze runuser; do
  command -v "$command" >/dev/null || { echo "missing prerequisite: $command" >&2; exit 1; }
done
[[ "$(python3.12 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')" == 3.12 ]] || { echo "Python 3.12 is required" >&2; exit 1; }
[[ "$(node --version)" == v22.* ]] || { echo "Node 22 is required" >&2; exit 1; }
[[ "$(pnpm --version)" == 10.13.1 ]] || { echo "pnpm 10.13.1 is required" >&2; exit 1; }
[[ "$(go version | awk '{print $3}')" == go1.25.7 ]] || { echo "Go 1.25.7 is required to reproduce the pinned AO build" >&2; exit 1; }
resolve_cli() {
  local name="$1" override="$2" candidate=""
  if [[ -n "$override" ]]; then
    [[ "$override" == /* ]] || { echo "$name override must be absolute: $override" >&2; exit 1; }
    candidate="$(readlink -f "$override")"
  else
    candidate="$(runuser -l "$deploy_user" -c "command -v -- $name" 2>/dev/null || true)"
    [[ -n "$candidate" ]] && candidate="$(readlink -f "$candidate")"
  fi
  [[ "$candidate" == /* && -f "$candidate" ]] || { echo "$name is not installed in deployment user $deploy_user's login PATH" >&2; exit 1; }
  runuser -u "$deploy_user" -- test -x "$candidate" || { echo "$name is not executable by deployment user: $candidate" >&2; exit 1; }
  case "$candidate" in
    "$repo/factory/deployment/bin/"*|/opt/chainsieve/factory-bin/*)
      echo "$name resolved to a ChainSieve wrapper instead of the installed CLI: $candidate" >&2
      exit 1
      ;;
  esac
  printf '%s\n' "$candidate"
}

gh_bin="$(resolve_cli gh "$gh_override")"
muse_bin="$(resolve_cli muse "$muse_override")"
agy_bin="$(resolve_cli agy "$agy_override")"
codex_bin="$(resolve_cli codex "$codex_override")"
cli_path="$(dirname "$gh_bin"):$(dirname "$codex_bin"):$(dirname "$muse_bin"):$(dirname "$agy_bin"):/usr/local/bin:/usr/bin:/bin"

runuser -u "$deploy_user" -- env HOME="$user_home" "$gh_bin" auth status >/dev/null
github_actor="$(runuser -u "$deploy_user" -- env HOME="$user_home" "$gh_bin" api user --jq .login)"
[[ -n "$github_actor" ]] || { echo "gh has no authenticated user for $deploy_user" >&2; exit 1; }
origin_repo="$(git -C "$repo" remote get-url origin | sed -E 's#^git@github.com:##; s#^https://github.com/##; s#\.git$##')"
[[ "$origin_repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "origin must identify one github.com repository" >&2; exit 1; }
runuser -u "$deploy_user" -- env HOME="$user_home" "$gh_bin" repo view "$origin_repo" --json nameWithOwner >/dev/null
runuser -u "$deploy_user" -- env HOME="$user_home" MUSE_NO_AUTO_UPDATE=1 "$muse_bin" --version >/dev/null
runuser -u "$deploy_user" -- env HOME="$user_home" "$agy_bin" --version >/dev/null
runuser -u "$deploy_user" -- env HOME="$user_home" "$codex_bin" --version >/dev/null
runuser -u "$deploy_user" -- env HOME="$user_home" "$codex_bin" login status >/dev/null || {
  echo "Codex is installed but its persisted deployment-user login is unavailable (CODEX_PROVIDER_UNAVAILABLE)" >&2
  exit 1
}

install -d -o root -g root -m 0755 /etc/chainsieve /opt/chainsieve/vendor /opt/chainsieve/factory-bin
install -d -o "$deploy_user" -g "$deploy_group" -m 0750 "$state" "$ao_data" "$(dirname "$venv")"
install -d -o "$deploy_user" -g "$deploy_group" -m 0700 "$ao_data/tmux"
runuser -u "$deploy_user" -- python3.12 -m venv --clear "$venv"
runuser -u "$deploy_user" -- "$venv/bin/python" - "$repo" <<'PY'
import pathlib
import sys
import tomllib

root = pathlib.Path(sys.argv[1])
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
[[ "$(git -C "$ao_source" rev-parse HEAD)" == "$ao_ref" ]]
[[ "$(git -C "$ao_source" rev-parse 'HEAD^{tree}')" == "$ao_tree" ]] || {
  echo "pinned AO source tree does not match the lock" >&2; exit 1;
}
[[ -z "$(git -C "$ao_source" status --porcelain --untracked-files=all)" ]] || {
  echo "pinned AO source checkout is dirty; refusing to compile local modifications" >&2; exit 1;
}
[[ -z "$(git -C "$ao_source" ls-files --others --ignored --exclude-standard)" ]] || {
  echo "pinned AO source checkout contains ignored local files; refusing an ambiguous build" >&2; exit 1;
}
(
  cd "$ao_source/backend"
  go test \
    ./internal/adapters/agent/muse ./internal/adapters/agent/agy \
    ./internal/adapters/reviewer/muse ./internal/adapters/reviewer/agy \
    ./internal/adapters/runtime/tmux ./internal/adapters/scm/github \
    ./internal/adapters/workspace/gitworktree ./internal/cli ./internal/daemon/... \
    ./internal/httpd/controllers ./internal/review/... ./internal/service/session \
    ./internal/session_manager ./internal/storage/sqlite/...
  go build -trimpath \
    -ldflags "-s -w -X github.com/aoagents/agent-orchestrator/backend/internal/cli.Version=0.12.3 -X github.com/aoagents/agent-orchestrator/backend/internal/cli.Commit=$ao_ref" \
    -o /usr/local/bin/ao ./cmd/ao
)
ao version | grep -F 0.12.3 >/dev/null
UV_TOOL_DIR=/opt/chainsieve/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin \
  uv tool install specify-cli --force --from "git+https://github.com/github/spec-kit.git@${spec_kit_ref}"
specify --version | grep -F 0.16.2 >/dev/null

install -o root -g root -m 0755 "$repo/factory/deployment/bin/muse" /opt/chainsieve/factory-bin/muse
install -o root -g root -m 0755 "$repo/factory/deployment/bin/agy" /opt/chainsieve/factory-bin/agy
install -o root -g root -m 0755 "$repo/factory/deployment/bin/chainsieve-review-context" /opt/chainsieve/factory-bin/chainsieve-review-context
install -o root -g root -m 0644 "$repo/factory/deployment/reviewer-contract.md" /opt/chainsieve/factory-bin/reviewer-contract.md
export CHAINSIEVE_RENDER_USER="$deploy_user" CHAINSIEVE_RENDER_GROUP="$deploy_group"
export CHAINSIEVE_RENDER_HOME="$user_home" CHAINSIEVE_RENDER_REPO="$repo"
export CHAINSIEVE_RENDER_STATE="$state" CHAINSIEVE_RENDER_AO_DATA="$ao_data" CHAINSIEVE_RENDER_VENV="$venv"
export CHAINSIEVE_RENDER_GH_BIN="$gh_bin" CHAINSIEVE_RENDER_MUSE_BIN="$muse_bin"
export CHAINSIEVE_RENDER_AGY_BIN="$agy_bin" CHAINSIEVE_RENDER_CODEX_BIN="$codex_bin"
export CHAINSIEVE_RENDER_CLI_PATH="$cli_path"
python3.12 - "$repo" <<'PY'
import os
import pathlib
import shlex
import sys

root = pathlib.Path(sys.argv[1])
values = {
    "@DEPLOY_USER@": os.environ["CHAINSIEVE_RENDER_USER"],
    "@DEPLOY_GROUP@": os.environ["CHAINSIEVE_RENDER_GROUP"],
    "@USER_HOME@": os.environ["CHAINSIEVE_RENDER_HOME"],
    "@REPO@": os.environ["CHAINSIEVE_RENDER_REPO"],
    "@STATE@": os.environ["CHAINSIEVE_RENDER_STATE"],
    "@AO_DATA@": os.environ["CHAINSIEVE_RENDER_AO_DATA"],
    "@VENV@": os.environ["CHAINSIEVE_RENDER_VENV"],
    "@CLI_PATH@": os.environ["CHAINSIEVE_RENDER_CLI_PATH"],
}

def render(source: pathlib.Path, target: pathlib.Path) -> None:
    text = source.read_text(encoding="utf-8")
    for marker, raw in values.items():
        escaped = raw.replace("%", "%%").replace("\\", "\\\\").replace('"', '\\"')
        text = text.replace(marker, escaped)
    target.write_text(text, encoding="utf-8")
    target.chmod(0o644)

for name in ("chainsieve-ao.service", "chainsieve-factory.service", "chainsieve-reboot-probe.service"):
    render(root / "factory/deployment/systemd" / name, pathlib.Path("/etc/systemd/system") / name)
render(root / "factory/deployment/logrotate/chainsieve-factory", pathlib.Path("/etc/logrotate.d/chainsieve-factory"))

deployment = {
    "CHAINSIEVE_DEPLOYMENT_USER": values["@DEPLOY_USER@"],
    "CHAINSIEVE_DEPLOYMENT_GROUP": values["@DEPLOY_GROUP@"],
    "CHAINSIEVE_USER_HOME": values["@USER_HOME@"],
    "CHAINSIEVE_REPO_PATH": values["@REPO@"],
    "CHAINSIEVE_FACTORY_STATE_DIR": values["@STATE@"],
    "AO_DATA_DIR": values["@AO_DATA@"],
    "CHAINSIEVE_VENV": values["@VENV@"],
    "CHAINSIEVE_FACTORY_PYTHON": values["@VENV@"] + "/bin/python",
    "CHAINSIEVE_GH_BIN": os.environ["CHAINSIEVE_RENDER_GH_BIN"],
    "CHAINSIEVE_MUSE_BIN": os.environ["CHAINSIEVE_RENDER_MUSE_BIN"],
    "CHAINSIEVE_AGY_BIN": os.environ["CHAINSIEVE_RENDER_AGY_BIN"],
    "CHAINSIEVE_CODEX_BIN": os.environ["CHAINSIEVE_RENDER_CODEX_BIN"],
    "CHAINSIEVE_MUSE_MODEL_MODE": "cli-default",
    "CHAINSIEVE_AGY_MODEL_MODE": "cli-default",
    "CHAINSIEVE_CODEX_MODEL_MODE": "cli-default",
}
path = pathlib.Path("/etc/chainsieve/deployment.env")
path.write_text("\n".join(f"{key}={shlex.quote(value)}" for key, value in deployment.items()) + "\n", encoding="utf-8")
path.chmod(0o644)
PY

systemd-analyze verify \
  /etc/systemd/system/chainsieve-ao.service \
  /etc/systemd/system/chainsieve-factory.service \
  /etc/systemd/system/chainsieve-reboot-probe.service
systemctl daemon-reload
systemctl start chainsieve-ao.service
trap 'systemctl stop chainsieve-ao.service >/dev/null 2>&1 || true' EXIT
export AO_RUN_FILE=/run/chainsieve-ao/running.json
ao_user=(runuser -u "$deploy_user" -- env HOME="$user_home" AO_RUN_FILE="$AO_RUN_FILE" AO_DATA_DIR="$ao_data")
if ! "${ao_user[@]}" /usr/local/bin/ao project get chainsieve --json >/dev/null 2>&1; then
  "${ao_user[@]}" /usr/local/bin/ao project add --path "$repo" --id chainsieve --name ChainSieve --worker-agent muse
fi
"${ao_user[@]}" /usr/local/bin/ao project set-config chainsieve --config-json "$(tr -d '\n' < "$repo/factory/deployment/ao-project-config.json")"
if ! "${ao_user[@]}" /usr/local/bin/ao project get chainsieve-canary --json >/dev/null 2>&1; then
  "${ao_user[@]}" /usr/local/bin/ao project add --path "$repo" --id chainsieve-canary --name ChainSieve-Canary --worker-agent muse
fi
"${ao_user[@]}" /usr/local/bin/ao project set-config chainsieve-canary --config-json "$(tr -d '\n' < "$repo/factory/deployment/ao-canary-project-config.json")"

runuser -u "$deploy_user" -- env \
  HOME="$user_home" PATH="$venv/bin:/opt/chainsieve/factory-bin:$cli_path" \
  CHAINSIEVE_GH_BIN="$gh_bin" CHAINSIEVE_MUSE_BIN="$muse_bin" \
  CHAINSIEVE_AGY_BIN="$agy_bin" CHAINSIEVE_CODEX_BIN="$codex_bin" \
  PYTHONPATH="$repo" CHAINSIEVE_FACTORY_EXPECTED_PYTHON="$venv/bin/python" \
  CHAINSIEVE_FACTORY_STATE_DIR="$state" CHAINSIEVE_FACTORY_PLAN="$repo/specs/factory/current-milestone.json" \
  AO_RUN_FILE="$AO_RUN_FILE" AO_DATA_DIR="$ao_data" \
  "$venv/bin/python" -m factory doctor --json
systemctl stop chainsieve-ao.service
trap - EXIT

echo "Installation verified for user $deploy_user (GitHub: $github_actor)."
echo "Start with: sudo systemctl enable --now chainsieve-ao chainsieve-factory"
