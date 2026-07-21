# Harness baseline owner checklist

Release-gate engineering verdict: **PASS**.

## Repository controls requiring owner configuration

- [ ] Protect `main`; require pull requests and the repository's Tier 1–3 status checks.
- [ ] Require at least one independent Codex/owner review for cluster integration and releases.
- [ ] Protect `harness-v*` tags from deletion or movement.
- [ ] Configure rulesets to block force pushes and direct task/cluster pushes to `main`.
- [ ] Confirm CI secrets expose only development/test PostgreSQL and MinIO credentials.
- [ ] Archive the original bootstrap prompt alongside this review if it exists outside Git; do not reconstruct or backdate it.

## Operating constraints to retain

- [ ] Keep PRD and manifest checksums protected; regenerate contracts only with `pnpm prd:compile`.
- [ ] Keep semantic artifact `semantic-stage-v1-4231cbf20630563aaf691ef8ac1ce15dec50260178405ba4a2eb622ae3612b34` immutable.
- [ ] Keep production capabilities disabled; bootstrap adapters must remain `SYNTHETIC_SHADOW`.
- [ ] Require live lease, fenced version, isolated task worktree, one atomic task commit, post-rebase verification, and independent cluster review.
- [ ] Do not grant transaction signing/submission, wallet custody, private-key, swap, approval, or exchange-order capability.
- [ ] Schedule `pnpm format:check` baseline cleanup as a P3-only change that excludes immutable PRD inputs or uses an explicit ignore policy.

## First implementation cluster

Run exactly:

```sh
zcode "$(cat clusters/G0/C-G0-IMPLEMENTATION.zcode-goal.md)"
```
