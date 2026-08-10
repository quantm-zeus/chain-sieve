import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface AutonomyPolicy {
  schemaVersion: '1.0.0';
  mode: 'FULL_AUTONOMY';
  humanReviewRequired: false;
  humanApprovalRequired: false;
  automatedIndependentReviewRequired: true;
  deterministicVerificationRequired: true;
  allowAutonomousSpecificationResolution: boolean;
  allowAutonomousCiRepair: boolean;
  allowAutonomousMerge: boolean;
  safeDefaults: {
    liveTradingEnabled: false;
    externalWriteCapabilitiesEnabled: false;
    secretMaterializationEnabled: false;
    irreversibleMigrationsEnabled: false;
  };
  limits: {
    taskCorrectionRounds: number;
    clusterCiCorrectionRounds: number;
    infrastructureRetryRounds: number;
    taskEscalationRounds: number;
    degradedRecoveryRounds: number;
  };
}

const boundedInteger = (
  value: unknown,
  minimum: number,
  maximum: number,
): value is number =>
  Number.isInteger(value) &&
  Number(value) >= minimum &&
  Number(value) <= maximum;

const exactBoolean = (value: unknown): value is boolean =>
  value === true || value === false;

export const loadAutonomyPolicy = async (
  root: string,
): Promise<AutonomyPolicy> => {
  try {
    const path = join(root, 'config', 'autonomy-policy.json');
    const parsed = JSON.parse(
      await readFile(path, 'utf8'),
    ) as Partial<AutonomyPolicy>;
    const safe = parsed.safeDefaults;
    const limits = parsed.limits;
    if (
      parsed.schemaVersion !== '1.0.0' ||
      parsed.mode !== 'FULL_AUTONOMY' ||
      parsed.humanReviewRequired !== false ||
      parsed.humanApprovalRequired !== false ||
      parsed.automatedIndependentReviewRequired !== true ||
      parsed.deterministicVerificationRequired !== true ||
      !exactBoolean(parsed.allowAutonomousSpecificationResolution) ||
      !exactBoolean(parsed.allowAutonomousCiRepair) ||
      !exactBoolean(parsed.allowAutonomousMerge) ||
      safe?.liveTradingEnabled !== false ||
      safe.externalWriteCapabilitiesEnabled !== false ||
      safe.secretMaterializationEnabled !== false ||
      safe.irreversibleMigrationsEnabled !== false ||
      !boundedInteger(limits?.taskCorrectionRounds, 1, 20) ||
      !boundedInteger(limits.clusterCiCorrectionRounds, 1, 20) ||
      !boundedInteger(limits.infrastructureRetryRounds, 1, 10) ||
      !boundedInteger(limits.taskEscalationRounds, 1, 10) ||
      !boundedInteger(limits.degradedRecoveryRounds, 1, 10)
    )
      throw new Error('AUTONOMY_POLICY_INVALID');
    return parsed as AutonomyPolicy;
  } catch (error) {
    if (error instanceof Error && error.message === 'AUTONOMY_POLICY_INVALID')
      throw error;
    throw new Error('AUTONOMY_POLICY_INVALID');
  }
};
