import type { DegradedResult } from '@ciag/domain';
import type { NotificationAdapter } from '@ciag/provider-contracts';

export * from './types.js';
export * from './guardrails.js';
export * from './policy.js';
export * from './lifecycle.js';
export * from './renderer.js';
export * from './outbox.js';
export * from './metrics.js';

export class ShadowNotificationAdapter implements NotificationAdapter {
  readonly messages: string[] = [];
  async enqueue(input: { outboxId: string; template: string; evidenceKeys?: string[] }): Promise<DegradedResult<{ deliveryId: string }>> {
    this.messages.push(`${input.outboxId}:${input.template}`);
    return {
      status: 'AVAILABLE',
      capabilityMode: 'SYNTHETIC_SHADOW',
      value: { deliveryId: `shadow-${input.outboxId}` },
    };
  }
}
