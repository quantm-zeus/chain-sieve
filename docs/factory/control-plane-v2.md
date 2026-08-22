# Controller V2 — Normative Architecture (Draft v0.1)

Status: DRAFT for review — implements §§7-27 of the refoundation prompt.
Replaces docs/factory/control-plane-v2.md target.

## 1. Authority ordering

1. `docs/spec/*`, PRD v6 + requirements JSON, `specs/factory/current-milestone.json` (when present)
2. ADRs
3. Valid executable verification
4. Existing product implementation
5. Factory implementation — never authoritative over 1-4.

## 2. Layering

```
GitHub / AO / CI / Git  (external facts)
         |
    Observation Layer  (pure data fetches, clock as observation)
         |
    Pure Deterministic Reducer  (state + observations -> next_state + commands)
         |
    Idempotent Command Executor  (persists command, executes, persists receipt)
         |
    GitHub / AO side effects
```

Strict separation: reducer imports no subprocess, no network, no clock.

## 3. Observations

Immutable facts for one tick:

- `Clock(t)`, `GitHead(branch->sha)`, `IssueState`, `PRState(head, checks, mergeable)`, `AOStatus`, `CIResult(workflow, head, gate_set)`, `ReviewEvidence(structured_json)`
- Time arrives only as `Clock` observation.

## 4. Reducer

```
reduce(state: State, obs: Observations) -> (State, Commands)
```

Properties: deterministic, byte-identical output for identical input, pure (no I/O), validates transitions via explicit table, emits no side effects.

## 5. SQLite Authority (§10)

Path: `~/.local/state/chainsieve-factory-v2/state.db`  
PRAGMAs: `journal_mode=WAL`, `foreign_keys=ON`.

Tables (minimal): `events`, `observations`, `work_items(workId PK, gapKey UNIQUE, strategyEpoch, status)`, `external_bindings(workId, issue, branch, pr, session)`, `commands(commandId PK, idempotencyKey UNIQUE, workId, type, payload, stateVersion)`, `command_receipts(commandId FK, status, result)`, `ci_evidence(pr, head, gate, result)`, `review_evidence(workId, pr, head, mode, scopeId, digest, verdict)`, `recovery_epochs(workId, epoch, domain, reason)`, `plan_operations(opId, kind, gapKey, workId)`, `metadata`.

V2 schema contains only V2 concepts — no translation of every V1 JSON field.

## 6. Workflow State Machine (§12)

Enum: PLANNED, READY, IMPLEMENTING, PR_OPEN, CI_WAIT, PRODUCT_FIX, REVIEW_BASELINE_WAIT, REVIEW_FIX, REVIEW_VERIFY_WAIT, MERGE_READY, MERGING, COMPLETE, RECOVERY, HUMAN_REQUIRED.

Every (state × observationClass) has explicit entry in transition table; invalid -> typed error + no side effect.

## 7. Commands (§13-14)

Types: CREATE_ISSUE, START_WORKER, SEND_PRODUCT_CORRECTION, TRIGGER_REVIEW, RETRY_CI_INFRA, REQUEST_STRATEGY, UPDATE_BRANCH, MERGE_PR, CLOSE_LEGACY_DUPLICATE (offline).

Each command has `commandId, idempotencyKey, expectedStateVersion, workId, kind, payload`. Persisted before execution; receipt after. UNIQUE idempotencyKey.

Exactly one code path per side-effect kind — enforced by architecture test.

## 8. Identity (§15-16)

- `workId` stable execution identity.
- `gapKey` stable gap identity derived from `milestoneId + normative requirement IDs / acceptance criterion IDs / invariant IDs`, never from LLM prose hash. If specs lack granular IDs, gapKey assigned once at accepted planning and persisted.
- `strategyEpoch` replaceable strategy.

Replan never changes workId (§17).

## 9. Plan Deltas (§17-18)

LLM proposes `PlanDelta = [ADD_GAP|UPDATE_STRATEGY|ADD_DEPENDENCY|REMOVE_DEPENDENCY|SUPERSEDE]`. UPDATE_STRATEGY keeps (workId,gapKey), bumps strategyEpoch. Milestone history monotonic: completed work never disappears.

## 10. Review Protocol (§20-21)

Only BASELINE and VERIFY. No FINAL_CONFIRMATION.

- BASELINE: first review -> PASS or CHANGES_REQUESTED + structured blocker list.
- VERIFY: same head, frozen blocker ledger + correction delta -> dispositions {RESOLVED,OPEN}, new blockers allowed only for correction regression or CRITICAL merge-safety.

Review JSON is strict schema; Markdown rendering non-authoritative.

## 11. Stale Evidence (§22)

Review identity = (workId, pr, head, reviewer, implementationProvider, mode, reviewScopeId, contextDigest). Old -> STALE (zero mutation, zero budget, zero dispatch).

## 12. CI (§23)

Binds (pr, exact head, workflow, required gate set). Failures classified PRODUCT/INFRASTRUCTURE/UNKNOWN. UNKNOWN -> fail-closed, not product failure.

## 13. Merge Predicate (§24)

Single pure `can_merge(state) -> bool` true iff: PR OPEN, current head == state.head, exact-head required CI PASS, exact-head semantic PASS, current scope/digest, opposite provider, no open blocker, mergeable, no unauthorized protected paths. Exactly one MERGE_PR producer.

## 14. Recovery (§25-26)

Strategy change, not identity. Domains: worker_liveness, session_restore, product_ci, ci_infra, semantic_review, integration — budgets isolated. Exhaustion -> UPDATE_STRATEGY or provider switch, not new work item. HUMAN_REQUIRED only for MISSING_CREDENTIAL, MISSING_PERMISSION, AUTHORITATIVE_SPEC_CONFLICT, DESTRUCTIVE_EXTERNAL_ACTION, AUTONOMOUS_STRATEGIES_EXHAUSTED.

## 15. Control-plane isolation (§27)

`controlPlaneRoot != workspaceRoot`. Control-plane imports from deployed canonical main only; product worktree supplies product Git/source/tests.

## 16. Explicit non-goals

- No mutable boolean sprawl (replan_attempted, review_terminal_rejection_sha, etc. -> typed evidence).
- No Markdown finding extraction in runtime.
- No whole-milestone replan replacement.
- No LLM prose as gap identity.
- No generic BLOCKED.
- No legacy migrationVersion chains in runtime.

## 17. V2 Module Sketch (§28)

```
factory/controller/
  domain.py       # Status enum, transition table
  reducer.py      # pure reduce()
  observations.py # observation types
  commands.py     # typed commands + idempotency
  store.py        # SQLite
  identity.py     # gapKey/workId/strategyEpoch
  review.py       # BASELINE/VERIFY handling
  ci.py           # exact-head CI authority
  recovery.py     # domain budgets
  executor.py     # idempotent executor
  adapters/{github,ao,git}.py
```

Subject to simplification during implementation.

## 18. Verification gates

Architecture tests (no subprocess/network in reducer), one-producer per side effect, Hypothesis state-machine invariants INV-01..INV-25, transition-table exhaustive tests, historical replay, migration dry-run, shadow, crash-restart, canary.

