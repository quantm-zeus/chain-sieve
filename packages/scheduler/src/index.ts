import type { DegradedResult } from '@ciag/domain';
import type { SchedulerAdapter } from '@ciag/provider-contracts';

export class DisabledProductionScheduler implements SchedulerAdapter {
  async schedule(): Promise<DegradedResult<{ triggerId: string }>> { return { status: 'NOT_AVAILABLE', reason: 'BOOTSTRAP_SCHEDULER_DISABLED' }; }
  async cancel(): Promise<void> { return; }
}
