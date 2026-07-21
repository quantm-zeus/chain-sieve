import type { DegradedResult } from '@ciag/domain';
import type { ModelProviderAdapter } from '@ciag/provider-contracts';

export class UnavailableModelProvider implements ModelProviderAdapter {
  async generate(): Promise<DegradedResult<{ artifactKey: string }>> { return { status: 'NOT_AVAILABLE', capabilityMode: 'SYNTHETIC_SHADOW', reason: 'MODEL_UNAVAILABLE_IN_BOOTSTRAP' }; }
}
