/**
 * @requirement FR-SIG-001 - Versioned Feature Registry
 * @requirement FR-DATA-004 - Deterministic signal execution
 *
 * Public API for signal-intelligence package: canonical snapshots + deterministic features.
 */

export * from './snapshot.js';
export * from './features.js';

// Re-export registry utilities for external consumption
export { FEATURE_REGISTRY, getFeatureDefinition } from './features.js';
