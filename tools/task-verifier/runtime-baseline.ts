import { readFile } from 'node:fs/promises';
import { waitForCompilerIdle } from '../prd-compiler/compiler.js';

export const NODE_RUNTIME_VERSION = '22.23.1';
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
): { node: string; pnpm: string; dockerfiles: number } => {
  const manifest = JSON.parse(files.packageJson) as {
    engines?: { node?: string; pnpm?: string };
    packageManager?: string;
  };
  if (manifest.engines?.node !== NODE_RUNTIME_VERSION)
    throw new Error(`NODE_ENGINE_BASELINE_DRIFT:${manifest.engines?.node ?? 'missing'}`);
  if (manifest.engines?.pnpm !== PNPM_RUNTIME_VERSION || manifest.packageManager !== `pnpm@${PNPM_RUNTIME_VERSION}`)
    throw new Error('PNPM_BASELINE_DRIFT');
  if (files.nodeVersion.trim() !== NODE_RUNTIME_VERSION || files.nvmrc.trim() !== NODE_RUNTIME_VERSION)
    throw new Error('NODE_VERSION_FILE_DRIFT');
  for (const [path, workflow] of [
    ['ci', files.ciWorkflow],
    ['scheduled', files.scheduledWorkflow],
  ] as const) {
    const versions = [...workflow.matchAll(/node-version:\s*([0-9.]+)/g)].map((match) => match[1]);
    if (versions.length === 0 || versions.some((version) => version !== NODE_RUNTIME_VERSION))
      throw new Error(`CI_NODE_BASELINE_DRIFT:${path}`);
  }
  const baseline = JSON.parse(files.architecturalBaseline) as { runtime?: string };
  if (baseline.runtime !== 'node-22') throw new Error('COMPILER_NODE_BASELINE_DRIFT');
  for (const [path, dockerfile] of Object.entries(files.dockerfiles)) {
    const versions = [...dockerfile.matchAll(/FROM node:([0-9.]+)-/g)].map((match) => match[1]);
    if (versions.length === 0 || versions.some((version) => version !== NODE_RUNTIME_VERSION))
      throw new Error(`DOCKER_NODE_BASELINE_DRIFT:${path}`);
  }
  return { node: NODE_RUNTIME_VERSION, pnpm: PNPM_RUNTIME_VERSION, dockerfiles: Object.keys(files.dockerfiles).length };
};

export const verifyRuntimeBaseline = async (): Promise<ReturnType<typeof validateRuntimeBaseline>> => {
  const readStable = async (path: string): Promise<string> => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await waitForCompilerIdle();
      try { return await readFile(path, 'utf8'); }
      catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    throw new Error(`RUNTIME_BASELINE_FILE_UNAVAILABLE:${path}`);
  };
  const dockerPaths = [
    'infra/docker/api.Dockerfile',
    'infra/docker/dashboard.Dockerfile',
    'apps/api/Dockerfile',
    'apps/dashboard/Dockerfile',
  ];
  const [packageJson, nodeVersion, nvmrc, ciWorkflow, scheduledWorkflow, architecturalBaseline, ...dockerfiles] =
    await Promise.all([
      readStable('package.json'),
      readStable('.node-version'),
      readStable('.nvmrc'),
      readStable('.github/workflows/ci.yml'),
      readStable('.github/workflows/scheduled-verification.yml'),
      readStable('tasks/generated/architectural-baseline.json'),
      ...dockerPaths.map(readStable),
    ]);
  return validateRuntimeBaseline({
    packageJson,
    nodeVersion,
    nvmrc,
    ciWorkflow,
    scheduledWorkflow,
    architecturalBaseline,
    dockerfiles: Object.fromEntries(dockerPaths.map((path, index) => [path, dockerfiles[index]!])),
  });
};
