# G0 execution plan

- Canonical branch: `cluster/g0`
- Formal dependency waves: one wave containing all 14 tasks
- Contract lock ceiling: 9
- Recommended initial parallelism: 1
- First recommended task: `T-G0-CORE`

The graph has no formal task edges, but this does not make unrestricted parallel execution safe. Start serially with the shared domain/schema foundation. DATA and DR share persistence and migration ownership; collector, cost, provider, and security task pairs share public-interface locks; every task may touch `tests/**` and `docs/implementation/**`.

The recommended operational order is:

1. `T-G0-CORE`
2. `T-G0-DATA`
3. `T-G0-SEC-01`
4. `T-G0-SEC-02`
5. `T-G0-MCP`
6. `T-G0-COL-01`
7. `T-G0-COL-02`
8. `T-G0-COST-01`
9. `T-G0-COST-02`
10. `T-G0-DISC`
11. `T-G0-DR`
12. `T-G0-PROV-01`
13. `T-G0-PROV-02`
14. `T-G0-TRACE`

Increase concurrency only after the first task merges cleanly and an owner confirms disjoint paths and interfaces for the proposed task set.
