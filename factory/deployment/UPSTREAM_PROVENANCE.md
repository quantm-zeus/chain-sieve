# Pinned upstream provenance

Verified on 2026-08-13. These are source-provenance facts, not substitutes for the live Ubuntu acceptance gates.

## Agent Orchestrator

- Requested upstream URL: `https://github.com/ComposioHQ/agent-orchestrator`.
- Current canonical URL: `https://github.com/Untrivial-ai/agent-orchestrator`. GitHub resolves the ComposioHQ URL to this repository and reports `fork=false`; this is a repository transfer/redirect, not a substituted fork.
- Tag: lightweight tag `v0.12.3`.
- Full commit: `b48c98c94ca0039ad1bc42bd1b78134d3ff5773d`.
- Git tree identity: `ea4d7ee451ca5a529422df66fa97a59af2c33a43`.
- Direct proof: `git ls-remote --tags https://github.com/ComposioHQ/agent-orchestrator.git refs/tags/v0.12.3 'refs/tags/v0.12.3^{}'` returned the commit above for the tag ref.
- Installation: clone the canonical repository, detach at the full commit, run the pinned production-relevant Go test packages under Go 1.25.7, then build `backend/cmd/ao` with `-trimpath` and version/commit linker values. The installed executable must report version `0.12.3` and commit `b48c98c94ca0039ad1bc42bd1b78134d3ff5773d`.
- Published Ubuntu `.deb` evidence: `agent-orchestrator-linux-x64.deb`, SHA-256 `d49e4afcfef26afcba931454f48c72d4f20e8572551f61ffb14b7f983e0b3bb3`, as returned by GitHub release asset metadata. Production intentionally builds the same source commit rather than installing this package.

The integration is exact pinned-upstream native support, not a ChainSieve patch, plugin, or fork:

- Muse detection: `backend/internal/adapters/agent/muse/muse.go` resolves `muse`, probes `--version`, and requires a `Muse Code ` signature.
- Muse unattended worker invocation: native persistent TUI with `--trust-workspace` and `--yolo` for bypass-permissions. ChainSieve's wrapper only pins the real executable and disables auto-update.
- Muse activity/input/exit: native hooks report active, blocked, and idle; continuous terminal detection recognizes structured `request user input`; AO runtime/session termination reports exit.
- Agy detection: `backend/internal/adapters/agent/agy/agy.go` resolves `agy` from PATH and documented install locations.
- Agy unattended worker invocation: native persistent TUI with `--add-dir <workspace>`, `--dangerously-skip-permissions`, `--prompt-interactive`, and the configured model. ChainSieve's wrapper injects the pinned model only when AO supplied none.
- Agy activity/exit: native BeforeAgent/AfterTool/AfterAgent/SessionEnd hooks report active, idle, and exit.
- Agy waiting-input limitation: the exact pin has no native Agy waiting-input hook or terminal detector. ChainSieve therefore does not claim this capability; the controller's bounded meaningful-progress timeout reports `STUCK` and applies bounded remediation. This limitation requires live validation before cutover.
- Workspace binding: AO's native `gitworktree` adapter creates one branch-bound worktree per session under its managed root; its tmux runtime starts the provider in that workspace. Agy additionally receives the exact path through `--add-dir`.
- Reviews: both `backend/internal/adapters/reviewer/muse` and `backend/internal/adapters/reviewer/agy` are native at this commit. ChainSieve binds their machine verdict to the exact PR head SHA before merge.
- SCM authentication: `backend/internal/adapters/scm/github/auth.go` defines `GHTokenSource` and invokes the ordinary `gh auth token` command internally. ChainSieve leaves the deployment user's normal persistent `gh auth login` state intact and installs no token wrapper, askpass broker, or AO patch. The Agy reviewer adapter intentionally gives its TUI an AO-owned `HOME`; the service therefore uses standard `GH_CONFIG_DIR=<deployment-home>/.config/gh` so review posting still uses that same login.
- Tracker limitation: the optional GitHub issue-enrichment tracker has a separate credential interface in this pin. Production leaves it disabled because the controller already supplies the complete trusted planning prompt at spawn.
- Managed worktree root: `backend/internal/daemon/lifecycle_wiring.go` configures `filepath.Join(AO_DATA_DIR, "worktrees")`.
- Safe teardown: `ao session kill` routes through Session Manager `Kill`, which removes a clean worktree and returns `freed=true`, but converts `ErrWorkspaceDirty` into a terminated, preserved workspace. `ao session cleanup` likewise skips dirty worktrees. ChainSieve uses these semantics only after its own no-PR/no-branch/no-durable-commit evidence gate.

## Spec Kit

- Upstream URL: `https://github.com/github/spec-kit`.
- Tag: annotated tag `v0.16.2`.
- Tag object: `10e42d94a392c69316ecfa8e36a5c26ac17f8d1a`.
- Peeled full commit: `4871b485f97c7fa452ec58eba325d87536c55c34`.
- Git tree identity: `88d4f9132dbb821cb1902f59aa856f4761514889`.
- Direct proof: `git ls-remote --tags https://github.com/github/spec-kit.git refs/tags/v0.16.2 'refs/tags/v0.16.2^{}'` returned the tag object and peeled commit above.
- Installation: `uv tool install specify-cli --force --from git+https://github.com/github/spec-kit.git@4871b485f97c7fa452ec58eba325d87536c55c34` with isolated tool roots. The executable must report `specify 0.16.2`.

## Codex route availability

The local installed CLI reported `codex-cli 0.147.0-alpha.6.5`. Its account-scoped model cache, refreshed at `2026-08-13T14:41:51.787360Z`, listed `gpt-5.6-luna`, `gpt-5.6-terra`, and `gpt-5.6-sol`; it listed medium reasoning for Luna and high reasoning for Terra/Sol. No fallback substitution was needed. This verifies the current audit account, not a future VPS credential; `factory:doctor` and a bounded VPS smoke must revalidate there.
