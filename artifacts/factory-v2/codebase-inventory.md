# Factory Control-Plane Inventory — V1

Generated: 2026-08-22T03:56:41Z  
Head: 954e9a9b9ae16e54db28001f72347742a81e3542  
Scope: factory/controller, factory/schemas, factory/prompts, factory/config, factory/cli, deployment, related tools/tests

## Classification Legend

- CANONICAL_RUNTIME — required at steady-state runtime
- CANONICAL_SCHEMA — normative wire/schema file
- OFFLINE_TOOL — developer/operator tool, not steady-state runtime
- MIGRATION_ONLY — historically needed for upgrades, not steady-state
- LEGACY_RUNTIME — incident-patched runtime that should collapse into smaller V2
- LEGACY_COMPATIBILITY — keeps old state/contexts working
- TEST_ONLY — test fixture/harness
- DEAD — no import/script/test reference
- UNKNOWN — needs runtime tracing to prove

## Controller Runtime

| File | Lines | Classification | Reason |
|------|------:|---|---|
| factory/controller/controller.py | 2951 | LEGACY_RUNTIME | Monolithic tick, entangled observation+mutation+GitHub/AO/shell/reasoning. Holds review-correction, CI-correction, replan epoch, liveness, session-restore, final-confirmation logic described in §0. |
| factory/controller/reasoning.py | 2432 | LEGACY_RUNTIME | Codex/LLM orchestration, replan recovery epochs, plan identity recovery, provider switching, wall-clock handling. V2 moves LLM to structured delta producer outside reducer. |
| factory/controller/findings.py | 613 | LEGACY_COMPATIBILITY | Markdown/bullet finding extraction, header keywords (FINDING_HEADER_KEYWORDS, NON_FINDING etc.), prose severity guessing. Task §19 says remove from runtime. |
| factory/controller/models.py | 509 | LEGACY_RUNTIME | PackageRecord with ~68 fields including ~15 interacting authority booleans/counters. V2 replaces with typed evidence + lifecycle enum (§11). GAP fingerprint mixes LLM prose — violates §16. |
| factory/controller/ao.py | 451 | CANONICAL_RUNTIME (needs split) | AO adapter + review semantics. Currently mixes parsing + authority. V2 needs adapters/github.py style pure adapter. |
| factory/controller/github.py | 428 | CANONICAL_RUNTIME (needs split) | GitHub + causal CI. Contains classification + required-gate logic that belongs in pure ci.py in V2. |
| factory/controller/prompts.py | 351 | LEGACY_COMPATIBILITY | Review prompt builders, closure prompts tied to old review modes. |
| factory/controller/review_context.py | 276 | LEGACY_COMPATIBILITY | Digest compatibility across review mode transitions, frozen findings handling. |
| factory/controller/config.py | 263 | LEGACY_RUNTIME | 34+ config fields including deprecated counters, generic correction counters, old plan controls. Needs audit §50. |
| factory/controller/policy.py | 239 | CANONICAL_RUNTIME (small) | Protected paths, review_required — keep but simplify. |
| factory/controller/store.py | 241 | LEGACY_RUNTIME | JSON state.json/events.jsonl + file lock. V2 replaces with SQLite WAL (§10). |
| factory/controller/commands.py | 108 | CANONICAL_RUNTIME (thin) | CommandRunner shell indirection — V2 replaces with typed command+receipt model. |
| factory/controller/doctor.py | 232 | OFFLINE_TOOL | Doctor — keep as operational tool, not in reducer import closure. |
| factory/cli.py | 219 | CANONICAL_RUNTIME | Entrypoint CLI — V2 keeps minimal commands. |
| factory/__init__.py, __main__.py | 6 | CANONICAL_RUNTIME | Package markers. |

## Schemas

| File | Lines | Classification |
|------|------:|---|
| factory/schemas/review.schema.json | 56 | LEGACY_COMPATIBILITY | Keeps old prose-based review contract. V2 §21 replaces with strict structured review. |
| factory/schemas/replan.schema.json | 58 | LEGACY_RUNTIME | Whole-milestone replacement. V2 §17 uses delta ops. |
| factory/schemas/milestone-plan.schema.json | 36 | CANONICAL_SCHEMA | Keep but narrow gap identity to stable keys. |
| factory/schemas/convergence.schema.json | 33 | CANONICAL_SCHEMA | Convergence output — keep minimal. |
| factory/schemas/final-audit.schema.json | 47 | LEGACY_RUNTIME | Final-confirmation phase — V2 §20 deletes. |
| factory/schemas/work-package.schema.json | 18 | CANONICAL_SCHEMA | Package shape. |
| factory/schemas/reasoning-canary.schema.json | 10 | OFFLINE_TOOL | Canary — offline. |

## Prompts

All `factory/prompts/*.md` are LEGACY_RUNTIME/LEGACY_COMPATIBILITY tied to full-prose authority. V2 §19 keeps only current structured prompts and moves legacy parsers to tools/.

## Deployment / Systemd

| File | Classification |
|------|---|
| factory/deployment/systemd/chainsieve-factory.service | CANONICAL_RUNTIME |
| factory/deployment/systemd/chainsieve-ao.service | CANONICAL_RUNTIME |
| factory/deployment/systemd/chainsieve-reboot-probe.service | OFFLINE_TOOL |
| factory/deployment/factory-command.sh | CANONICAL_RUNTIME (needs V2 entrypoint switch) |
| factory/deployment/bin/{agy,muse,chainsieve-review-context} | OFFLINE_TOOL |

## Package scripts (factory-related)

`factory:run/start/stop/restart/status/history/doctor/sync/converge/final-audit/upstream-check` — CANONICAL_RUNTIME shims over factory-command.sh, need V2 canonicalization (§51). `legacy:*` and `zcode:*` are LEGACY_COMPATIBILITY shims.

## Tests

`tests/factory/*.py` (26 files) — mix of invariant tests worth porting and V1 implementation-detail tests to delete per §52. Requires per-file classification pass (next artifact).

## Summary Counts

- Canonical runtime files before: ~13 py + 7 schemas + 6 prompts = 26
- Legacy/compat files before: ~9 of the controller modules (findings, review_context, large parts of reasoning/controller/models/config)
- Estimated dead/unknown: 0 proven dead yet; dynamic import scan required (Phase 1 dependency graph)
- Transitive runtime import closure: ~14 Python modules (all of controller) plus store/config — budget target is < 10 modules in V2.
