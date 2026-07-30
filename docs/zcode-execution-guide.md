# ZCode execution guide

The permanent owner entry point is:

```sh
cd "/Users/quantm/Documents/My Projects/chain-sieve"
pnpm zcode
```

Run it from the clean root checkout on `main`. The root checkout is the control plane and never receives product implementation. The command discovers the generated cluster/task graphs, current lifecycle evidence, canonical branch interface, context pack, and deterministic next action. It prepares or resumes one fenced task in an isolated task worktree beneath the canonical cluster worktree, copies the complete `/goal` command, and opens that worktree in ZCode Desktop. In ZCode, press `Cmd+V`, then Enter.

Task worktree preparation is idempotent. A clean, registered workspace on the expected task branch and cluster head is reused; a compatible unattached branch or safe empty partial directory is recovered. Conflicting registrations, dirty worktrees, foreign repositories, and unclaimed commits fail closed without deleting work. Errors print the top-level code, the command, and a sanitized, bounded lower-level cause.

Worktree create and cleanup commands are loaded from the synchronized root control plane and receive the cluster worktree as an explicit source. This keeps tooling fixes on `main` authoritative even while the cluster branch remains pinned to its independently verified head.

When ZCode stops or finishes, run the same root command again. The orchestrator retains a failed task, invokes the real verifier and merge queue, advances to the next task, verifies completed clusters, and discovers the next dependency-ready cluster. It never trusts an agent-authored completion message or PASS field.

The strictly read-only views are:

```sh
pnpm zcode -- --dry-run
pnpm zcode:status
```

Neither command changes lifecycle state, fencing, locks, Git, clipboard, ZCode, pull requests, or CI.

`pnpm zcode:g0` is a deprecated compatibility alias for the same project-wide orchestrator. It contains no G0-specific selection logic.

Repository policy still requires an independent cluster review. When that gate is reached, the command prints the exact review-package path and resumes idempotently after valid PASS evidence is committed. Capability activation remains a separate governed action.
