# Provider-neutral implementation-agent control plane

The owner entry point is `pnpm agent`. It defaults to the `antigravity` adapter; `pnpm antigravity` is an explicit alias, and `pnpm zcode` remains an optional compatibility alias. Read-only state is `pnpm agent:status` (`pnpm zcode:status` is the same provider-neutral view).

Reusable lifecycle authority lives in `tools/agent/lib`. It owns discovery, task and cluster decisions, worktree isolation, leases and fencing, path locks, context binding, immutable task execution goals, launch receipts, verification, merge-queue coordination, cluster integration, and completion. Provider adapters under `tools/agent/providers` own only detection, prompt envelopes, clipboard copying, exact-workspace opening, and the owner-facing paste instruction.

Provider selection never mutates lifecycle credentials. A valid lease inside the safety window stops launch with `LEASE_RENEWAL_REQUIRED`; an expired lease stops with `LEASE_EXPIRED:AUTHORITATIVE_RECOVERY_REQUIRED`. The only mutation paths are the compare-and-swap commands `pnpm agent:renew -- <task-id> ...` and `pnpm agent:recover -- <task-id> ...`. They serialize lifecycle writes, bind every expected credential and workspace value, increment fencing exactly once, and return the same receipt on an exact retry. Both commands accept `--ttl-minutes <integer>` from 15 through 240 and default to 120 minutes. The TTL is part of the request hash, immutable receipt, expiry calculation, result evidence, and idempotency binding; changing it creates a conflicting request and never changes an existing result.

Recovery binds the lifecycle acquisition base independently from the current task commit and tree. The authoritative post-commit form is:

```sh
pnpm agent:recover -- <task-id> \
  --expected-expired-lease-id <lease-id> \
  --expected-fencing-version <version> \
  --holder <holder> \
  --expected-task-state <state> \
  --expected-task-branch <branch> \
  --expected-task-worktree <canonical-path> \
  --expected-lifecycle-base-commit <acquisition-base> \
  --expected-task-head-commit <current-head> \
  --expected-task-head-tree <current-tree> \
  --expected-tracked-work-sha256 <hash> \
  --expected-untracked-work-sha256 <hash> \
  --expected-legacy-contract-sha256 <hash> \
  --expected-legacy-context-sha256 <hash> \
  --ttl-minutes 120
```

The prior `--expected-base-commit` flag is not reinterpreted as a post-commit binding. It is accepted only in the compatibility form below, where the lifecycle base and current task HEAD are explicitly required to be the same commit; the current tree remains mandatory:

```sh
pnpm agent:recover -- <task-id> ... \
  --expected-base-commit <same-base-and-head> \
  --expected-task-head-tree <current-tree> \
  --ttl-minutes 120
```

`SELF_REVIEWING`, `VERIFYING`, `VERIFIED`, and `MERGE_QUEUED` recovery requires the lifecycle implementation commit/tree to match the independently validated worktree HEAD/tree. `IMPLEMENTING` permits an unchanged base with no implementation commit, or an existing lifecycle commit/tree binding. Recovery never changes `baseCommit`. A successful recovery may refresh the trusted control-plane verification baseline, while the immutable implementation commit, tree, self-review, and original launch receipt remain unchanged and are authorized only through the immediately retired recovery credential.

Agent runtime evidence is written beneath `<git-common-dir>/ciag-runtime/agent`. Existing valid receipts beneath `<git-common-dir>/ciag-runtime/zcode` remain readable. A provider switch generates a provider-specific receipt while retaining the authoritative task ID, lease ID, holder, fencing version, base, worktree, context hash, and conformance hash. It does not release or reacquire a task.

The Antigravity adapter detects `agy-ide`, the `Antigravity IDE` macOS application (`com.google.antigravity-ide`), the `Antigravity` macOS application (`com.google.antigravity`), and `agy`. It prefers the supported `agy-ide --new-window <task-worktree>` launcher. It never uses accessibility scripting, pastes, approves, or selects a task. The complete payload is copied with `pbcopy`; the owner performs only `Cmd+V` and `Enter`.

Gemini 3.6 Flash is the default implementation-model policy. The payload records that policy. Where the installed Antigravity workspace launcher has no supported model-selection flag, choose Gemini 3.6 Flash once in the Antigravity IDE and retain that workspace setting.

Generated context packs contain exact normative excerpts, an implementation brief, interface plan, behavior-test matrix, and referenced-path classification. `SPECIFICATION_GAP` and `INVALID_REFERENCE` block readiness. Acceptance criteria are assigned exactly once at task, cluster-integration, or project-system level without altering normative text; cross-cutting tasks receive interface facets that explicitly do not claim full criterion satisfaction.

Every task contract binds a control-plane-owned conformance manifest under `artifacts/conformance/<task-id>/manifest.json`. Task write scopes exclude those manifests and `tests/conformance`. The verifier runs task-owned tests, the immutable oracle, architecture controls, placeholder and prohibited-capability scans, and source verification. Test-quality analysis rejects trivial assertions and tests that never invoke imported production behavior; HIGH and CRITICAL tasks additionally require a seeded-fault, mutation, or property-based gate.

Implementation agents stop after one atomic commit and receipt-bound self-review. Authoritative verification runs from a clean trusted control-plane checkout and receives the task worktree only as an untrusted target. The acquisition baseline binds the original contract, context, conformance manifest, source indexes, path policy, required tests, verifier policy, control-plane commit/tree, and release. Verification rejects control-plane changes before executing target tests and validates the complete provider-neutral launch receipt against independently derived state.

An active task whose legacy contract differs from newly generated contracts continues against the immutable lifecycle-bound contract and context in its existing worktree under its existing holder. Its trusted baseline adds the current control-plane-owned semantic conformance manifest without replacing the legacy contract. That binding remains selected through verification, merge queue, merge, and cleanup evidence archival; no active contract hash is replaced in place.

Cluster verification freezes a product commit, tree, contract hash, cluster result, and task attestations before independent review. The accepted review strategy is an artifact-only child commit whose direct parent is the frozen product commit. Validation rejects implementation reviewers, stale results, mismatched bindings, product changes, and unresolved P0/P1 findings.
