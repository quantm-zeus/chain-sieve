# ChainSieve G0 ZCode readiness

Verdict: `ZCODE_READY_APP_SETUP_REQUIRED`

The repository-side G0 preparation is complete on canonical branch
`cluster/g0`. ZCode Desktop is installed; the only remaining application setup
is confirming the desired model connection through its UI.

## Immutable baseline

- Release: `harness-v1.0.1`
- Tag object: `a3bc4476b270efe911da12a4d649e3e5ebcdf69c`
- Release commit: `1027664eb708b4c1249dda5f1c33f5129946ab3e`
- Release tree: `706e400d3eb5c41a95209523bb034f2e2c60bd34`
- Cluster ID: `C-G0-IMPLEMENTATION`
- Canonical execution branch: `cluster/g0`
- Evidence-generation branch/remote head: `6f69ed2fd987eb2d59516c16358091e8cfcee11c`
- Evidence-generation tree: `86037d226607afc52e1f0ea5950d96134f3d8e3e`
- Canonical worktree:
  `/Users/quantm/Documents/My Projects/chain-sieve-worktrees/g0`
- Branch-resolution amendment SHA-256:
  `11f56651bd9f35e693c340ae9f628f682b5fa20dc139119b6b10b3753bae7614`

The previous blocked report is preserved byte-for-byte under
`artifacts/handoff/G0/history/2026-07-29-blocked/`.

## Task and execution state

- Tasks: 14
- States: all `READY`
- Fencing versions: all 0
- Active task leases: 0
- Active cluster leases: 0
- Active path locks: 0
- `IMPLEMENTING`, `VERIFIED`, or `MERGED` tasks: 0
- Formal dependency waves: one wave containing all 14 tasks
- Contract lock ceiling: 9
- Recommended operational parallelism: 1
- First recommended task: `T-G0-CORE`

Although the formal graph has no edges, execution starts serially because all
tasks share test/documentation paths, several task pairs share public
interfaces, and DATA/DR share persistence and migration ownership.

## Handoff status

- Task inventory: PASS, SHA-256
  `e3aa850d2fcae7123893b3321b907f46a0ab5a99420578e1f050ebee67bf51e6`
- Context packs: 14/14 PASS; deterministic aggregate
  `7891120c4bfda855313a5380da386e9f67f59942fb27a684cb4bbc5ee62bd2ea`
- Per-task goals: 14/14 PASS
- Cluster goal: PASS, SHA-256
  `0971d911f4cd702abaa4e9a0c946fdf15718ad9a1a9313b7df7ec50ac3a13074`
- Generated-command validation: PASS, including unknown-command rejection
- Preflight: `tools/zcode/g0-preflight.sh`
- Preflight `--validate-only`: PASS 10/10, exit 0, no mutation
- Goal Mode payload: `artifacts/handoff/G0/g0-goal-payload.md`

## Verification

The pinned Node 22/pnpm suite passes: install, build, lint, typecheck, format,
87 tests, specification verification, deterministic drift, requirement
coverage, architecture, placeholder scan, prohibited-capability scan,
migrations, harness verification, and lifecycle scenarios A–H.

The lifecycle harness passes from its attested clean release/main source
context. A diagnostic invocation from `cluster/g0` collides because its
isolated fixture clones the current branch and then deliberately creates a
fresh branch with the same name; no harness code was changed.

`pnpm cluster:ready` identifies G0 as ready to begin.
`pnpm cluster:verify C-G0-IMPLEMENTATION` correctly exits 1 with
`CLUSTER_TASK_NOT_MERGED:T-G0-COL-01:READY`. G0 is therefore ready, not
implemented, not verified, and not completed.

## Desktop status

- `/Applications/ZCode.app`: installed
- `/Users/quantm/Applications/ZCode.app`: not installed
- Version: `3.5.3` (build `3.5.3.3911`)
- Bundle identifier: `dev.zcode.app`
- Process status: already running when inspected; not started by preparation
- Model connection: `ZCODE_MODEL_CONNECTION_REQUIRES_OWNER_UI`
- Terminal ZCode CLI: not required

No ZCode implementation session was started by this preparation. No
implementation lease was acquired. No product implementation occurred. No task
entered `IMPLEMENTING`. `main` and `harness-v1.0.1` remain unchanged.
