# Provider-neutral implementation-agent control plane

The owner entry point is `pnpm agent`. It defaults to the `antigravity` adapter; `pnpm antigravity` is an explicit alias, and `pnpm zcode` remains an optional compatibility alias. Read-only state is `pnpm agent:status` (`pnpm zcode:status` is the same provider-neutral view).

Reusable lifecycle authority lives in `tools/agent/lib`. It owns discovery, task and cluster decisions, worktree isolation, leases and fencing, path locks, context binding, immutable task execution goals, launch receipts, verification, merge-queue coordination, cluster integration, and completion. Provider adapters under `tools/agent/providers` own only detection, prompt envelopes, clipboard copying, exact-workspace opening, and the owner-facing paste instruction.

Agent runtime evidence is written beneath `<git-common-dir>/ciag-runtime/agent`. Existing valid receipts beneath `<git-common-dir>/ciag-runtime/zcode` remain readable. A provider switch generates a provider-specific receipt while retaining the authoritative task ID, lease ID, holder, fencing version, base, worktree, context hash, and conformance hash. It does not release or reacquire a task.

The Antigravity adapter detects `agy-ide`, the `Antigravity IDE` macOS application (`com.google.antigravity-ide`), the `Antigravity` macOS application (`com.google.antigravity`), and `agy`. It prefers the supported `agy-ide --new-window <task-worktree>` launcher. It never uses accessibility scripting, pastes, approves, or selects a task. The complete payload is copied with `pbcopy`; the owner performs only `Cmd+V` and `Enter`.

Gemini 3.6 Flash is the default implementation-model policy. The payload records that policy. Where the installed Antigravity workspace launcher has no supported model-selection flag, choose Gemini 3.6 Flash once in the Antigravity IDE and retain that workspace setting.

Generated context packs contain exact normative excerpts, an implementation brief, interface plan, behavior-test matrix, and referenced-path classification. `SPECIFICATION_GAP` and `INVALID_REFERENCE` block readiness. Acceptance criteria are assigned exactly once at task, cluster-integration, or project-system level without altering normative text; cross-cutting tasks receive interface facets that explicitly do not claim full criterion satisfaction.

Every task contract binds a control-plane-owned conformance manifest under `artifacts/conformance/<task-id>/manifest.json`. Task write scopes exclude those manifests and `tests/conformance`. The verifier runs task-owned tests, the immutable oracle, architecture controls, placeholder and prohibited-capability scans, and source verification. Test-quality analysis rejects trivial assertions and tests that never invoke imported production behavior; HIGH and CRITICAL tasks additionally require a seeded-fault, mutation, or property-based gate.

An active task whose legacy contract differs from newly generated contracts continues against the contract and context in its existing worktree under its existing holder. Before integration it requires an independent semantic-conformance artifact bound to the legacy commit/tree and the newly partitioned cross-cutting acceptance facets. No active contract hash is replaced in place.
