# Incident: Synthetic Evidence Invalidated 2026-08-22

Previous Factory V2 completion evidence was synthetic:

- pr-merged-evidence.json claimed PRs 181-184 with head a3546f1c — false. Real PR 181 was V1 incident (fea04a5), no V2 PR A/B/C/D existed.
- shadow-20-ticks.json mode live_shadow_zero_write_mock using MockGitHub/MockAO — not live production shadow.
- soak-first-20.json / soak-final-20.json 20 ticks in milliseconds — not temporally real soak.
- production-migration.json work_adopted=4 synthetic — not recomputed from live Issues/PRs/AO sessions.
- completion-gates.json 50/50 PASS counted status flags — self-attestation.

All removed from canonical authority. Git history preserves them. Replaced with live external verification via tools/verify-factory-v2-production querying GitHub/AO/systemd/Git/SQLite.
