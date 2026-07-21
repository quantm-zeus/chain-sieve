# Harness preparation report

- Status: **PASS**
- Verified implementation head: `a46ac4fd46df35ab73cc07314258addb392a1428` (before this report-only commit)
- Requirements: 397/397 mapped
- Acceptance criteria: 204/204 mapped
- Invariants / ADRs: 44 / 58 indexed
- API routes / persistence entities independently extracted: 181 / 286
- Task contracts: 70
- Cluster contracts: 8
- Generated files: 977
- Compiler determinism: PASS; repeated aggregate hash `f8df660f8668884b166164a09dae2a2104dd50dab440a28a54b2d4d681ae929e`
- Mutation suite: 10/10 critical mutations rejected
- Completion-forgery control: PASS
- Lease fencing and path-lock conflict: PASS
- Git lifecycle simulation: READY → LEASED → VERIFIED → MERGED, followed by automatic revert on injected post-merge failure; one atomic task commit verified
- Architecture, placeholders, prohibited capabilities, migrations, walking skeleton, coverage, generated drift, build, lint, typecheck, Vitest and Playwright: PASS

## First implementation handoff

Recommended first ZCode cluster: `C-G0-IMPLEMENTATION`, whose 10 tasks establish data truth, capability, security, collector, cost, Tool Core/MCP and traceability foundations.

Exact first ZCode command:

```sh
zcode "$(cat clusters/G0/C-G0-IMPLEMENTATION.zcode-goal.md)"
```

The cluster goal requires one task at a time, a current lease, independent verification, and one atomic commit per task. All capability influence remains disabled or shadow.

## Publishing operations

Branch and release-candidate tag publication are attempted after this report commit. Pull-request creation is blocked until the remote has a base branch and `gh auth login` succeeds. The exact later PR command is `gh pr create --base main --head bootstrap/agent-harness-and-codebase --title "Bootstrap CIAG codebase and agent harness" --body-file artifacts/final/harness-preparation-report.md`.
