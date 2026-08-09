# Repository agent operating contract

## Authority and integrity

Authority is ordered: the immutable PRD normative prose and IDs; the normative requirements manifest; accepted ADRs that do not weaken either; generated contracts; then implementation. Before editing, run `pnpm spec:verify` and compare `docs/spec/SHA256SUMS`. Stop on drift. Never edit generated artifacts by hand; run `pnpm prd:compile`.

## Scope and dependency order

Work only from an acquired task contract and its context pack. Implement dependency groups G0 through G7 in DAG order. Honor the task read set, write set, allowed paths, forbidden paths, locks, budgets, and stop conditions. One task receives one branch, one current lease with a fencing version, and one atomic commit. A cluster may contain several small tasks, but each task is acquired, verified, self-reviewed, and committed before the next.

## Allowed and forbidden actions

Agents may implement, test, document, migrate, and instrument the exact IDs in their task. They may add deterministic degraded behavior. They may not weaken, omit, renumber, reinterpret, waive, or silently replace normative content. Financial execution, transaction construction or submission, signing, custody, private credentials, paid fallback in `STRICT_FREE`, direct model notifications, direct dashboard-provider/database access, and automatic capability or alpha activation are forbidden.

## Engineering state is not capability state

`IMPLEMENTED` means code exists. It never implies `AVAILABLE`, `PROVEN`, or `ACTIVE`. New intelligence remains `DISABLED` or `SHADOW` until every data, quality, cost, security, statistical, rights, claims, and owner-approval gate passes. Alpha artifacts stage immutably and cannot promote or reactivate themselves.

## Task execution

Acquire with `pnpm task:acquire <task-id> --holder <agent>`. Renew before expiry using the returned lease version. A stale holder/version must stop immediately. Validate dependencies and public interface hashes; then implement positive, negative, degraded, replay, recovery, and rollback behavior. SQL migrations are owned by persistence tasks, are authoritative, append-only after merge, and must have matching Drizzle definitions. Do not edit another active task's locked path.

Self-review the entire diff for scope, point-in-time leakage, fabricated success, unsafe fallbacks, capability activation, secret exposure, migration reversibility, and missing observability. Run the task's commands and `pnpm task:verify <task-id>`. A result file cannot prove its own PASS. Complete only with independently derived evidence and an atomic commit.

## Blocking and amendments

Stop for source drift, unmet dependencies, interface drift, lease loss, lock collision, unclear safety semantics, budget excess, an unowned migration, or any requested prohibited capability. Record a blocking result with exact evidence. Changes to contract scope require a versioned, source-hash-bound, owner-approved amendment; agents cannot self-approve one. Do not paper over a block with a placeholder.

## Verification and merge

Required repository checks are `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm spec:verify`, `pnpm prd:drift-check`, `pnpm requirements:coverage`, `pnpm architecture:verify`, `pnpm placeholders:scan`, `pnpm prohibited-capabilities:scan`, `pnpm migration:verify`, and `pnpm harness:verify`. Task agents never merge to `main`. The merge queue rebases and re-verifies, then cluster integration runs. A failed post-merge check reverts the task commit. An independent fresh-context machine review must PASS before merge or release. Product/task/specification semantics are reviewed by a separate isolated Muse session. Maintenance/control-plane/tooling repairs may instead be reviewed by a separate isolated Antigravity session. The reviewer must not modify the reviewed change and must return evidence-backed PASS or FAIL.
