# Codebase bootstrap report

- Status: **PASS with one environment limitation**
- Repository branch: `bootstrap/agent-harness-and-codebase`
- Stable base: repository was unborn; no prior commit or remote `main` existed
- Verified implementation head: `a46ac4fd46df35ab73cc07314258addb392a1428` (before this report-only commit)
- Node / pnpm: `v24.14.0` / `10.13.1`
- Workspace projects: 21 packages/apps plus the workspace root

## Source integrity

- PRD SHA-256: `baa521d9c67e67a86d7ddb111c793b67462ed4c7acc89cec34ab9f5ade077299`
- Requirements SHA-256: `e0f9f1284473fe097fde591138d16984ae8580feaf13333e22594717eec690ff`
- Audit SHA-256: `ab4be13b6aeac998f13daa89ae08f4b9f5d6280b4018bd171b7b128b412a47f8`

## Results

- API build/start: PASS. Live `/health` returned 200; dependency `/readiness` returned the correct 503 while local PostgreSQL was stopped. Graceful SIGINT shutdown passed.
- Dashboard production build: PASS. Playwright Chromium smoke test: 1/1 PASS.
- Docker/local infrastructure: Compose configuration PASS. Container startup was not run because no Docker daemon exists at `unix:///Users/quantm/.docker/run/docker.sock`.
- Migration: empty-to-latest, rerun behavior, and no-backdating constraint PASS in the hermetic PostgreSQL emulator. Service-backed PostgreSQL execution is deferred to CI/local Docker because the daemon is unavailable.
- S3-compatible and filesystem object-store adapters: build PASS.
- Full Vitest suite: 29/29 PASS across 9 files.
- Walking skeleton: PASS, including six persisted stages, immutable evidence, `available_at` replay guard, duplicate suppression, outbox retry, virtual-time maturity, trace closure, and `SYNTHETIC_SHADOW` capability.
- Architecture: PASS, 8 executable boundary controls.
- Security: placeholder and prohibited-capability scans PASS; MCP invalid-origin rejection and official Streamable HTTP transport tests PASS.

## Unresolved findings

No known P0/P1 code defect remains. Environment/publishing limitations are: Docker daemon unavailable; the remote repository has no `main`/default base branch; GitHub CLI is not authenticated, so a pull request cannot be created from this environment. No product or alpha capability is active.
