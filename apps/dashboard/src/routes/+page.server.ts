import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
  let readiness: { status: string; capabilityMode: string; dependencies: { name: string; ready: boolean; detail: string }[] } = { status: 'not_available', capabilityMode: 'SYNTHETIC_SHADOW', dependencies: [] };
  try { const response = await globalThis.fetch(`${process.env.PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:3000'}/api/v1/readiness`); const value: unknown = await response.json(); if (value && typeof value === 'object' && 'status' in value && 'dependencies' in value) readiness = value as typeof readiness; }
  catch { readiness = { status: 'not_available', capabilityMode: 'SYNTHETIC_SHADOW', dependencies: [] }; }
  return { generatedAt: new Date().toISOString(), readiness, sections: [
    { title: 'Overview', value: 'Bootstrap foundation', detail: 'Modular monolith; production capabilities disabled' },
    { title: 'System readiness', value: readiness.status, detail: readiness.dependencies.map((dependency) => `${dependency.name}:${dependency.ready ? 'ready' : 'unavailable'}`).join(', ') || 'API unavailable' },
    { title: 'Harness status', value: 'Deterministic', detail: 'Compiler, verifier, leases, locks, and merge queue' },
    { title: 'Requirement coverage', value: '397 requirements', detail: 'Generated mappings, not implementation claims' },
    { title: 'Task graph', value: 'G0 → G7', detail: 'Dependency-group ordered task contracts' },
    { title: 'Cluster graph', value: '8 clusters', detail: 'One governed implementation cluster per group' },
    { title: 'Walking-skeleton result', value: 'Synthetic shadow', detail: 'Point-in-time evidence through mature evaluation' },
  ] };
};
