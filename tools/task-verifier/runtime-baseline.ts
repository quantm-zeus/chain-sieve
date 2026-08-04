import { readFile } from 'node:fs/promises';
import { waitForCompilerIdle } from '../prd-compiler/compiler.js';

export const NODE_RUNTIME_MAJOR = '22';
export const NODE_ENGINE_RANGE = '>=22 <23';
export const PNPM_RUNTIME_VERSION = '10.13.1';

export interface RuntimeBaselineFiles {
  packageJson: string;
  nodeVersion: string;
  nvmrc: string;
  ciWorkflow: string;
  scheduledWorkflow: string;
  architecturalBaseline: string;
  dockerfiles: Record<string, string>;
}

export const validateRuntimeBaseline = (
  files: RuntimeBaselineFiles,
): { node: