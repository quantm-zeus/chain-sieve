# Codex cluster review guide

Codex reviews the full cluster diff adversarially after deterministic CI passes. Review requirement and acceptance evidence, invariants, dependency direction, temporal integrity, negative paths, migrations, security, rollback, and activation state. Emit `PASS` only with no release-blocking P0/P1 finding; otherwise issue bounded findings for the fix goal.
