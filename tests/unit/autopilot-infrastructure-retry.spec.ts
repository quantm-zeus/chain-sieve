import { describe, expect, it } from 'vitest';
import {
  assertInfrastructureRetryBudget,
  infrastructureRetryKey,
} from '../../tools/autopilot/autopilot.js';
import { classifyAutonomyFailure } from '../../tools/product-factory/recovery-contract.js';

describe('persistent infrastructure retry safety', () => {
  it('binds retry counters to action, target, and target version', () => {
    expect(infrastructureRetryKey('CONTINUE_TASK', 'T-1', 'head-a')).toBe(
      'orchestration:CONTINUE_TASK:T-1:head-a',
    );
    expect(infrastructureRetryKey('CONTINUE_TASK', 'T-1', 'head-a')).not.toBe(
      infrastructureRetryKey('CONTINUE_TASK', 'T-1', 'head-b'),
    );
    expect(infrastructureRetryKey('CONTINUE_TASK', 'T-1', 'head-a')).not.toBe(
      infrastructureRetryKey('CONTINUE_TASK', 'T-2', 'head-a'),
    );
  });

  it('fails deterministically before a zero-iteration retry loop can throw undefined', () => {
    expect(() =>
      assertInfrastructureRetryBudget(
        'orchestration:CONTINUE_TASK:T-1:head-a',
        3,
        3,
      ),
    ).toThrow(
      'AUTOPILOT_INFRASTRUCTURE_RETRY_EXHAUSTED:orchestration:CONTINUE_TASK:T-1:head-a:3/3',
    );
  });

  it('classifies exhausted infrastructure retries as external blockers', () => {
    expect(
      classifyAutonomyFailure(
        'AUTOPILOT_INFRASTRUCTURE_RETRY_EXHAUSTED:orchestration:CONTINUE_TASK:T-1:head-a:3/3',
      ),
    ).toBe('EXTERNAL_BLOCKER');
  });
});
