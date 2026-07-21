# Implementation workflow

Run source verification, compile the PRD, choose the first READY cluster and acquire one task. Work only inside its contract scope. Verify and atomically commit it, then repeat. Cluster review follows deterministic integration checks. Capability rollout is a separate governed action.
