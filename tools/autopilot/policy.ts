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
  };
}

const positiveInteger = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) > 0;

export const loadAutonomyPolicy = async (
  root: string,
): Promise<AutonomyPolicy> => {
  const path = join(root, 'config', 'autonomy-policy.json');
  const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<AutonomyPolicy>;
  if (
    parsed.schemaVersion !== '1.0.0' ||
    parsed.mode !== 'FULL_AUTONOMY' ||
    parsed.humanReviewRequired !== false ||
    parsed.humanApprovalRequired !== false ||
    parsed.automatedIndependentReviewRequired !== true ||
    parsed.deterministicVerificationRequired !== true ||
    parsed.safeDefaults?.liveTradingEnabled !== false ||
    parsed.safeDefaults.externalWriteCapabilitiesEnabled !== false ||
    parsed.safeDefaults.secretMaterializationEnabled !== false ||
    parsed.safeDefaults.irreversibleMigrationsEnabled !== false ||
    !positiveInteger(parsed.limits?.taskCorrectionRounds) ||
    !positiveInteger(parsed.limits.clusterCiCorrectionRounds) ||
    !positiveInteger(parsed.limits.infrastructureRetryRounds)
  )
    throw new Error('AUTONOMY_POLICY_INVALID');
  return parsed as AutonomyPolicy;
};
