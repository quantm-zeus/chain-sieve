import { errorCode } from '../agent/lib/errors.js';
import { executeOrchestration } from '../agent/lib/executor.js';
import { findRepositoryRoot } from '../agent/lib/paths.js';
import { SystemCommandRunner } from '../agent/lib/system.js';
import { ZCodeProvider } from '../agent/providers/zcode.js';

const dryRun = process.argv.includes('--dry-run');

try {
  const root = findRepositoryRoot();
  const runner = new SystemCommandRunner();
  await executeOrchestration(root, runner, {
    dryRun,
    provider: new ZCodeProvider(runner),
  });
} catch (error) {
  console.error(errorCode(error));
  process.exitCode = 1;
}
