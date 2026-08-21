import type { DegradedResult } from '@ciag/domain';
import type { ModelProviderAdapter } from '@ciag/provider-contracts';

export class UnavailableModelProvider implements ModelProviderAdapter {
  async generate(): Promise<DegradedResult<{ artifactKey: string }>> {
    return {
      status: 'NOT_AVAILABLE',
      capabilityMode: 'SYNTHETIC_SHADOW',
      reason: 'MODEL_UNAVAILABLE_IN_BOOTSTRAP',
    };
  }
}

export * from './errors.js';
export * from './model-profiles.js';
export * from './budget-tracker.js';
export * from './confinement.js';
export * from './deterministic-planner.js';
export * from './bounded-runtime.js';
export * from './evidence-families.js';
export * from './voi-planner.js';
export * from './conditional-skeptic.js';

