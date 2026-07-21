import { compile, driftCheck } from './compiler.js';

const command = process.argv[2] ?? 'compile';
try { const result = command === 'drift-check' ? await driftCheck() : await compile(); console.log(JSON.stringify({ command, status: 'PASS', ...result })); } catch (error) { console.error(JSON.stringify({ command, status: 'FAIL', error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; }
