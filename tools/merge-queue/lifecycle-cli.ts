import { runLifecycleHarness } from './lifecycle-harness.js';

try {
  const result = await runLifecycleHarness();
  console.log(JSON.stringify({ status: result.verdict.status, ...result }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
