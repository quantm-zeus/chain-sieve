export const load = () => ({
  generatedAt: new Date().toISOString(),
  sections: [
    { title: 'Overview', value: 'Bootstrap foundation', detail: 'Modular monolith; production capabilities disabled' },
    { title: 'System readiness', value: 'Local dependencies', detail: 'See API /api/v1/readiness' },
    { title: 'Harness status', value: 'Deterministic', detail: 'Compiler, verifier, leases, locks, and merge queue' },
    { title: 'Requirement coverage', value: '397 requirements', detail: 'Generated mappings, not implementation claims' },
    { title: 'Task graph', value: 'G0 → G7', detail: 'Dependency-group ordered task contracts' },
    { title: 'Cluster graph', value: '8 clusters', detail: 'One governed implementation cluster per group' },
    { title: 'Walking-skeleton result', value: 'Synthetic shadow', detail: 'Point-in-time evidence through mature evaluation' },
  ],
});
