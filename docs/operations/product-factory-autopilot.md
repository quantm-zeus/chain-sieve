# Muse-driven product factory autopilot (legacy, superseded)

> This describes the retired architecture retained only for migration diagnostics. Use `docs/operations/oss-factory.md` and `pnpm factory:*` for production.

ChainSieve remains the deterministic root control plane. Muse Code CLI is the primary implementation, review, convergence, and correction agent, but it never receives authority to push, merge, rewrite normative requirements, or change control-plane policy.

## Goal

Run a project from the repository's immutable PRD and normative docs until the implementation is not only task-complete but product-complete.

The outer product-factory loop combines the strongest patterns from spec-driven development, fresh-context task agents, adaptive replanning, independent product verification, and continuous PR/CI automation:

1. Compile and verify the normative PRD through the existing PRD compiler.
2. Run the existing ChainSieve task/cluster autopilot to completion.
3. Run the complete deterministic repository verification suite.
4. Create a fresh detached worktree at the exact completed product commit.
5. Ask Muse to independently compare PRD, requirements, ADRs, generated contracts, code, tests, and evidence.
6. Require a commit-bound machine-readable convergence report with requirement IDs.
7. If the report is `PASS`, finish.
8. If gaps remain, create a fresh correction worktree from the frozen `main` commit.
9. Ask Muse to repair only product source, product tests, and operational docs. Normative specs, generated contracts, policies, workflows, tools, migrations, manifests, and secrets are forbidden.
10. Run the complete deterministic verification suite before any correction commit.
11. The trusted control plane commits, pushes, opens the correction PR, waits for required CI, and merges only when clean.
12. Re-run ChainSieve autopilot and product convergence from the new `main` commit.
13. Stop only at product convergence or after the bounded product-correction limit.

## One-time Muse configuration

Use the Muse Code CLI headless and auto-approval flags from the installed Muse version. ChainSieve intentionally does not guess beta CLI flags.

```bash
export CHAINSIEVE_MUSE_COMMAND='muse'
export CHAINSIEVE_MUSE_ARGS_JSON='["<real-headless-arg>","<real-auto-approval-arg>","{prompt}"]'
export CHAINSIEVE_MUSE_PERMISSION_MODE='preapproved'
```

Validate the environment first:

```bash
pnpm autopilot -- --doctor --provider muse
```

## Run the full product factory

```bash
pnpm product:autopilot
```

Muse is the default provider for `product:autopilot`. Another registered provider can be selected explicitly for testing:

```bash
pnpm product:autopilot -- --provider codex
```

The product correction budget is bounded by the control-plane maximum of three rounds. It can be reduced per run:

```bash
pnpm product:autopilot -- --max-product-corrections 1
```

Do not use a cycle limit for a whole-product run. The product factory owns the outer completion loop and the existing ChainSieve autopilot owns task and cluster progression.

## Convergence contract

Muse may write exactly one audit artifact in its detached audit worktree:

```json
{
  "schemaVersion": "1.0.0",
  "status": "PASS",
  "productCommit": "<frozen commit>",
  "gaps": [],
  "notes": []
}
```

A gap must bind to one or more normative IDs and include concrete evidence. A stale report, a `PASS` report containing gaps, a `GAPS` report without gaps, or a gap without requirement IDs is rejected by the control plane.

## Correction safety boundary

Product convergence corrections may modify only:

- `apps/**`
- `packages/**`
- `tests/**`
- `docs/operations/**`

The correction agent cannot change PRD/spec authority, generated tasks or clusters, control-plane tools, GitHub workflows, autonomy policy, dependency manifests, lockfiles, migrations, runtime evidence, or secrets. This prevents an agent from making the verifier pass by changing the definition of success.

## Completion semantics

`AUTOPILOT_COMPLETE` means the task and cluster DAG is complete. `PRODUCT_FACTORY_COMPLETE` is stronger: the full deterministic suite is green and an independent Muse convergence audit bound to the final product commit reports no remaining normative product gaps.
