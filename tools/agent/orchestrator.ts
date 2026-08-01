import { errorCode } from './lib/errors.js';
import { executeOrchestration } from './lib/executor.js';
import { findRepositoryRoot } from './lib/paths.js';
import { SystemCommandRunner } from './lib/system.js';
import { createProvider, parseProvider } from './providers/index.js';

const dryRun = process.argv.includes('--dry-run');

try {
  const root = findRepositoryRoot();
  const runner = new SystemCommandRunner();
  const provider = createProvider(parseProvider(process.argv.slice(2)), runner);
  await executeOrchestration(root, runner, { dryRun, provider });
} catch (error) {
  console.error(errorCode(error));
  process.exitCode = 1;
}
