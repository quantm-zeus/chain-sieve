# Formatting policy

`pnpm format` and `pnpm format:check` apply the repository's deterministic whitespace, line-ending, final-newline, conflict-marker, and JSON-validity rules to maintained source, tests, application code, repository configuration, CI, and maintained documentation. This policy intentionally avoids a repository-wide style rewrite.

Repository files are classified as follows:

- Owned source: `apps/**`, `packages/**`, and `tools/**`; formatting is required.
- Owned configuration: root configuration, package manifests, Dockerfiles where supported, Compose, and `.github/**`; formatting is required when a formatter supports the file type.
- Owned tests: `tests/**`; formatting is required.
- Owned documentation: maintained Markdown outside immutable or content-addressed archives; formatting is required.
- Generated artifacts: compiler-owned task, cluster, schema, context, and `artifacts/spec/**` output; excluded because formatting would invalidate deterministic hashes and must instead be changed by `pnpm prd:compile`.
- Immutable PRD inputs: `docs/spec/**`; excluded and never rewritten for style.
- External or frozen evidence and exact originals: release-attestation evidence, prior final/review artifacts, and archived original prompt Markdown; excluded so their recorded SHA-256 hashes remain stable.
- Frozen repair contracts: content-addressed repair YAML and checksum files; excluded after approval.

`pnpm-lock.yaml` is generated only by pinned pnpm under Node.js 22 and is never passed through a generic text formatter. Ignore entries may protect only one of the excluded classifications above. They may not be used to hide a formatting failure in maintained code, tests, CI, configuration, or documentation.
