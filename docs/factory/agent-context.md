# Agent Context — Factory V2

Read these first for any factory/controller work:

1. `docs/factory/control-plane-v2.md` — normative state machine, commands, SQLite, merge predicate
2. `factory/controller/domain.py` — WorkStatus, WorkItem, evidence types
3. `factory/controller/reducer.py` — pure reduce(state, observations) + transition table
4. `factory/controller/store.py` — SQLite WAL schema
5. `factory/controller/identity.py` — gapKey/workId (stable IDs only)
6. `tests/factory_v2/test_architecture.py` + `test_invariants.py` — architecture invariants

Runtime import closure: `controller/domain, reducer, store, identity, review, ci, recovery, commands, observations, transitions, executor, adapters/*` — ~846 LOC.

No V1 compatibility code in runtime. Historical parsing lives in `tools/factory-v2-replay` and `tools/factory-v1-to-v2` only.

Test commands:
- `.venv/bin/python -m pytest tests/factory_v2 -q`
- `pnpm factory:status` / `factory:doctor` (V2 entrypoint after cutover)
