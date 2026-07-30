import { errorCode } from './lib/errors.js';
import { executeOrchestration } from './lib/executor.js';
import { findRepositoryRoot } from './lib/paths.js';
import { SystemCommandRunner } from './lib/system.js';

const dryRun = process.argv.includes('--dry-run');

try {
  const root = findRepositoryRoot();
  await executeOrchestration(root, new SystemCommandRunner(), { dryRun });
} catch (error) {
  console.error(errorCode(error));
  process.exitCode = 1;
}
