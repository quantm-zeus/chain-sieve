import { describe, expect, it } from 'vitest';
import {
  autonomousEscalationFingerprint,
  isAutonomousEscalationFailure,
  selectAutonomousEscalationStage,
} from '../../tools/product-factory/autonomous-escalation.js';
import type { AutonomyPolicy } from '../../tools/autopilot/policy.js';

const policy: Pick<AutonomyPolicy, 'limits'> = {
  limits: {
    taskCorrectionRounds: 2,
    clusterCiCorrectionRounds: 3,
    infrastructureRetryRounds: 1,
    taskEscalationRounds: 2,
    degradedRecoveryRounds: 2,
  },
};

describe('autonomous escalation', () => {
  it('recognizes budget and bounded-recovery exhaustion without widening genuine safety failures', () => {
    expect(isAutonomousEscalationFailure('MUSE_TASK_CALL_BUDGET_EXHAUSTED:T-1')).toBe(true);
    expect(isAutonomousEscalationFailure('MUSE_SEMANTIC_CALL_BUDGET_EXHAUSTED:12/12')).toBe(true);
    expect(isAutonomousEscalationFailure('AUTOPILOT_CORRECTION_LIMIT:T-1:2')).toBe(true);
    expect(isAutonomousEscalationFailure('PRODUCT_FACTORY_CONVERGENCE_LIMIT:REQ-1')).toBe(true);
    expect(isAutonomousEscalationFailure('SECRET_EXPOSURE:token')).toBe(false);
    expect(isAutonomousEscalationFailure('AUTONOMOUS_MERGE_DISABLED')).toBe(false);
  });

  it('uses task fallback first, then degraded recovery, then stops same-evidence looping', () => {
    expect(selectAutonomousEscalationStage(1, true, policy)).toBe('TASK_FALLBACK');
    expect(selectAutonomousEscalationStage(2, true, policy)).toBe('TASK_FALLBACK');
    expect(selectAutonomousEscalationStage(3, true, policy)).toBe('DEGRADED_RECOVERY');
    expect(selectAutonomousEscalationStage(4, true, policy)).toBe('DEGRADED_RECOVERY');
    expect(selectAutonomousEscalationStage(5, true, policy)).toBe('EXHAUSTED');
  });

  it('does not consume task-fallback quota for project-level convergence failures', () => {
    expect(selectAutonomousEscalationStage(1, false, policy)).toBe('DEGRADED_RECOVERY');
    expect(selectAutonomousEscalationStage(2, false, policy)).toBe('DEGRADED_RECOVERY');
    expect(selectAutonomousEscalationStage(3, false, policy)).toBe('EXHAUSTED');
  });

  it('requires new root or task evidence to receive a fresh escalation fingerprint', () => {
    const base = autonomousEscalationFingerprint({
      failure: 'MUSE_TASK_CALL_BUDGET_EXHAUSTED:T-1',
      rootHead: 'root-a',
      taskId: 'T-1',
      taskHead: 'task-a',
    });
    expect(base).toBe(
      autonomousEscalationFingerprint({
        failure: 'MUSE_TASK_CALL_BUDGET_EXHAUSTED:T-1:extra-detail',
        rootHead: 'root-a',
        taskId: 'T-1',
        taskHead: 'task-a',
      }),
    );
    expect(base).not.toBe(
      autonomousEscalationFingerprint({
        failure: 'MUSE_TASK_CALL_BUDGET_EXHAUSTED:T-1',
        rootHead: 'root-a',
        taskId: 'T-1',
        taskHead: 'task-b',
      }),
    );
    expect(base).not.toBe(
      autonomousEscalationFingerprint({
        failure: 'MUSE_TASK_CALL_BUDGET_EXHAUSTED:T-1',
        rootHead: 'root-b',
        taskId: 'T-1',
        taskHead: 'task-a',
      }),
    );
  });
});
