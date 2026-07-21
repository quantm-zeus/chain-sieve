import type { DegradedResult } from '@ciag/domain';
import type { NotificationAdapter } from '@ciag/provider-contracts';

export class ShadowNotificationAdapter implements NotificationAdapter {
  readonly messages: string[] = [];
  async enqueue(input: { outboxId: string; template: string }): Promise<DegradedResult<{ deliveryId: string }>> { this.messages.push(`${input.outboxId}:${input.template}`); return { status: 'AVAILABLE', value: { deliveryId: `shadow-${input.outboxId}` } }; }
}

export const assertNotificationSource = (source: 'DETERMINISTIC_POLICY' | 'MODEL_OUTPUT'): void => { if (source === 'MODEL_OUTPUT') throw new Error('MODEL_DIRECT_NOTIFICATION_PROHIBITED'); };
