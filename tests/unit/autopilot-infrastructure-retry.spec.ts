import { describe, expect, it } from 'vitest';
import {
  assertInfrastructureRetryBudget,
  infrastructureRetryKey,
  infrastructureRetryStartAttempt,
  isTransientInfrastructureFailure,
} from '../../tools/autopilot/autopilot.js';
import { AgentError } from '../../tools/agent/lib/errors.js';
import { classifyAutonomyFailure } from '../../tools/product-factory/recovery-contract.js';

describe('persistent infrastructure retry safety', () => {
  it('binds retry counters to control-plane version, action, target, and target version', () => {
    expect(infrastructureRetryKey('main-a', 'CONTINUE_TASK', 'T-1', 'head-a')).toBe(
      'orchestration:v2:main-a:CONTINUE_TASK:T-1:head-a',
    );
    expect(infrastructureRetryKey('main-a', 'CONTINUE_TASK', 'T-1', 'head-a')).not.toBe(
      infrastructureRetryKey('main-b', 'CONTINUE_TASK', 'T-1', 'head-a'),
    );
    expect(infrastructureRetryKey('main-a', 'CONTINUE_TASK', 'T-1', 'head-a')).not.toBe(
      infrastructureRetryKey('main-a', 'CONTINUE_TASK', 'T-1', 'head-b'),
    );
    expect(infrastructureRetryKey('main-a', 'CONTINUE_TASK', 'T-1', 'head-a')).not.toBe(
      infrastructureRetryKey('main-a', 'CONTINUE_TASK', 'T-2', 'head-a'),
    );
  });

  it('does not inherit a persistent attempt when persistence is disabled', () => {
    expect(infrastructureRetryStartAttempt(1, false)).toBe(0);
    expect(infrastructureRetryStartAttempt(3, false)).toBe(0);
    expect(infrastructureRetryStartAttempt(2, true)).toBe(2);
  });

  it('distinguishes transient infrastructure failures from lifecycle and deterministic failures', () => {
    expect(
      isTransientInfrastructureFailure(
        new Error('AUTOPILOT_GITHUB_FAILED:run:list:temporary network timeout'),
      ),
    ).toBe(true);
    expect(
      isTransientInfrastructureFailure(
        new Error('ROOT_FETCH_FAILED:Could not resolve host: github.com'),
      ),
    ).toBe(true);
    expect(
      isTransientInfrastructureFailure(
        new Error('AUTONOMOUS_PROVIDER_FAILED:Our servers are experiencing high traffic right now, please try again'),
      ),
    ).toBe(true);
    expect(
      isTransientInfrastructureFailure(
        new AgentError('GENERATED_CONTRACT_DRIFT', 'pnpm prd:drift-check', [
          'GENERATED_DRIFT:tasks/G0/T-1.contract.json',
        ]),
      ),
    ).toBe(false);
    expect(
      isTransientInfrastructureFailure(
        new AgentError('LIFECYCLE_BINDING_MISSING', 'T-1'),
      ),
    ).toBe(false);
    expect(
      isTransientInfrastructureFailure(
        new Error('AUTOPILOT_CORRECTION_LIMIT:T-1:2'),
      ),
    ).toBe(false);
  });

  it('never treats authentication or permission failures as transient', () => {
    expect(
      isTransientInfrastructureFailure(
        new Error('AUTOPILOT_GITHUB_FAILED:AUTH_FAILED:bad credentials'),
      ),
    ).toBe(false);
    expect(
      isTransientInfrastructureFailure(
        new Error('AUTOPILOT_GIT_FAILED:PERMISSION_DENIED:repository'),
      ),
    ).toBe(false);
  });

  it('fails deterministically before a zero-iteration retry loop can throw undefined', () => {
    expect(() =>
      assertInfrastructureRetryBudget(
        'orchestration:v2:main-a:CONTINUE_TASK:T-1:head-a',
        3,
        3,
      ),
    ).toThrow(
      'AUTOPILOT_INFRASTRUCTURE_RETRY_EXHAUSTED:orchestration:v2:main-a:CONTINUE_TASK:T-1:head-a:3/3',
    );
  });

  it('classifies exhausted infrastructure retries as external blockers', () => {
    expect(
      classifyAutonomyFailure(
        'AUTOPILOT_INFRASTRUCTURE_RETRY_EXHAUSTED:orchestration:v2:main-a:CONTINUE_TASK:T-1:head-a:3/3',
      ),
    ).toBe('EXTERNAL_BLOCKER');
  });
});
