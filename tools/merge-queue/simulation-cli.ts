import { simulateGitLifecycle } from './simulation.js';

try { console.log(JSON.stringify({ status: 'PASS', result: await simulateGitLifecycle() }, null, 2)); } catch (error) { console.error(JSON.stringify({ status: 'FAIL', error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; }
