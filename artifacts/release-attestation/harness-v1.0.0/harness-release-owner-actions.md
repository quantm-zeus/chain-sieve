# ChainSieve harness release owner actions

Do not move, delete, or recreate `harness-v1.0.0`. Do not start `C-G0-IMPLEMENTATION` from this release.

## 1. Authenticate and correct repository controls

Run:

```sh
gh auth login --hostname github.com --git-protocol ssh --web
gh repo edit quantm-zeus/chain-sieve --default-branch main
```

In GitHub, open **Settings → Rules → Rulesets** and create two active rulesets:

1. Branch target `refs/heads/main`: block deletion and non-fast-forward updates, require pull requests, require at least one approval, dismiss stale approvals, require approval of the latest push, require resolved conversations, and require all four workflow jobs: `Tier 0 · static and unit`, `Tier 1 · task contracts`, `Tier 2 · cluster integration`, and `Tier 3 · pre-main`.
2. Tag target `refs/tags/harness-v*`: block deletion and non-fast-forward updates. Do not block creation, because new immutable patch tags must remain possible.

Confirm after configuration:

```sh
gh repo view quantm-zeus/chain-sieve --json defaultBranchRef
gh api repos/quantm-zeus/chain-sieve/rulesets
gh api repos/quantm-zeus/chain-sieve/branches/main/protection
```

## 2. Approve a bounded repair contract

Create and approve a versioned, source-hash-bound task/amendment covering only:

- rejecting forged or empty-evidence task results and any code/commit not cryptographically bound to the result and current cluster head;
- regression tests for forged task/cluster results and post-result code changes;
- Node.js 22 in `package.json`, `.node-version`, docs, generated runtime baseline, lockfile validation, and every CI tier;
- actual production API/dashboard Dockerfiles and a `linux/arm64` Buildx gate, with non-root runtime and no Playwright payload;
- implementing or removing the nonexistent `task:begin` and `task:self-review` commands in generated ZCode goals;
- preserving `x-correlation-id` on successful MCP responses and adding a controllably slow MCP timeout regression;
- a meaningful formatting baseline that excludes immutable PRD inputs and deterministic generated output while formatting owned code/config/docs;
- assessing and, if compatible, upgrading `drizzle-orm` to `>=0.45.2` for GHSA-gpj5-g38j-94v9;
- CI execution on release tags or an authenticated dispatch path so the exact patch-tag commit has recorded Actions evidence.

After approval, create `fix/harness-v1.0.1-attestation`, acquire its lease, and keep all changes within its declared paths and budgets.

## 3. Preserve process provenance

The exact bootstrap and independent-review prompts are absent. If authoritative originals exist, add them without reconstruction or backdating at:

```text
docs/prompts/01-bootstrap-codebase-and-harness.md
docs/prompts/02-independent-codebase-review.md
docs/prompts/prompt-manifest.json
```

The manifest must record `path`, `sha256`, `purpose`, `created_at`, and `source`. Until both exact originals are supplied, retain `BLOCKED_PROMPT_ARCHIVAL`.

## 4. Re-release, never retag

Repeat the complete clean-room suite on official Node 22 and a clean Docker state. Require the controlled forgery to fail, require a successful `linux/arm64` production build, and verify Actions and rulesets with authenticated API access. Merge through the protected workflow, then create a new annotated tag:

```sh
git tag -a harness-v1.0.1 -m 'ChainSieve harness attested patch release v1.0.1' <fully-verified-main-commit>
git push origin refs/tags/harness-v1.0.1
```

Replace `<fully-verified-main-commit>` only with the independently verified full commit SHA. Never force-push the tag.
