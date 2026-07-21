import { assertNotificationSource } from '@ciag/alerts';
import { CapabilityRegistry } from '@ciag/capability-registry';
import { assertNoBackdating } from '@ciag/domain';

export const controls = {
  requireAvailableAt(record: Record<string, unknown>): void { if (typeof record.available_at !== 'string') throw new Error('AVAILABLE_AT_REQUIRED'); },
  rejectBackdating(eventTime: string, availableAt: string): void { assertNoBackdating(eventTime, availableAt); },
  requireStrictFree(costClass: 'FREE' | 'METERED' | 'UNKNOWN'): void { if (costClass !== 'FREE') throw new Error('STRICT_FREE_DENIED'); },
  rejectModelNotification(): void { assertNotificationSource('MODEL_OUTPUT'); },
  preserveOutcomeDistinction(input: { signalSuccess: boolean; tradableSuccess?: boolean }): void { if (input.signalSuccess && input.tradableSuccess === undefined) throw new Error('TRADABLE_OUTCOME_REQUIRED'); },
  rejectSilentSchemaDrift(known: readonly string[], received: readonly string[]): void { if (received.some((field) => !known.includes(field))) throw new Error('SCHEMA_DRIFT'); },
  rejectAutoActivation(): void { new CapabilityRegistry().activate(); },
};
