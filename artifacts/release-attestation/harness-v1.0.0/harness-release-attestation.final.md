# ChainSieve harness release attestation — final

Verdict: **FAIL_RELEASE** for `harness-v1.0.0`.

The exact published tag is annotated and immutable in this run, but it is not verified for release. Tag object `a8515700a7c09cbf2ea7dc97e59c19e91d4be316` peels to commit `90027c40753d502d1893fd518382080b5302dd63`, tree `561efa1c33b1cef08972d844fd42ad38c65b25b8`, which equals `origin/main` and contains prior verified repair commit `1d92ab62a8cf9268750c3ab494d04af098b32979`.

## Required answers

| Question | Answer |
|---|---|
| Is the exact published tag verified? | **No.** `FAIL_RELEASE`. |
| Does it work on Node.js 22? | **No.** Frozen install fails under official Node `v22.23.1`; the package, `.node-version`, compiler baseline, docs, and CI require Node 24. |
| Does live PostgreSQL and MinIO verification pass? | **Yes.** PostgreSQL 17, clean migrations/reruns, ledger/readiness/rollback, durable rows, MinIO provisioning, retrieval, and immutable-write behavior passed. |
| Does `linux/arm64` build pass? | **No.** There is no production Dockerfile, so no production image can be cross-built. The PostgreSQL and MinIO service images themselves resolved and ran as `linux/arm64`. |
| Are all harness gates real? | **No.** The cluster verifier accepted forged empty-evidence PASS task results plus source changed after result generation. |
| Are branch/tag protections enabled? | **Unverified.** GitHub API credentials are absent. Independently, the remote default branch is incorrectly set to `bootstrap/agent-harness-and-codebase`. |
| Is the first ZCode cluster ready? | **No.** Its generated goal calls missing `task:begin` and `task:self-review` scripts, and verifier integrity is broken. |
| What command should run next? | `gh auth login --hostname github.com --git-protocol ssh --web`, then perform the owner actions. Do not start ZCode. |

The initial evidence is immutable outside the tag:

- `harness-v1.0.0.initial.json`: `ec3935eeda0d587307ce8b2bf4077443cfaadd72a58b2c0f3b2fffdebb89e6a4`
- `harness-v1.0.0.initial.md`: `d599821dc37df04253dd5ad8ae39720955c3b62bf5401c3083b4533dbc6f3ffe`

No repair branch was created because the repository operating contract permits edits only from an acquired task contract and context pack. No generated task authorizes changes spanning the cluster verifier, Node/CI/runtime baseline, production container, and generated lifecycle goal. Creating or widening one autonomously would violate the stop rule. An owner-approved, versioned, source-hash-bound repair task is required before creating `fix/harness-v1.0.1-attestation`.

The exact tag checkout is clean, all controlled mutations were reverted, Git-local forged runtime files were removed, and the clean Docker test stack and volumes were removed. Neither `main` nor any remote tag was changed.

After the bounded repair is independently verified, publish a new annotated `harness-v1.0.1`; never move `harness-v1.0.0`. Only then should the first cluster be invoked with either:

```sh
zcode "$(cat clusters/G0/C-G0-IMPLEMENTATION.zcode-goal.md)"
```

or interactively with `/goal`, followed by the exact contents of `clusters/G0/C-G0-IMPLEMENTATION.zcode-goal.md`. The installed ZCode interface was not verifiable on this host because `zcode` is not installed.
