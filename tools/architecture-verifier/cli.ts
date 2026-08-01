import { scanPlaceholders, scanProhibitedCapabilities, verifyArchitecture } from './verify.js';
const command = process.argv[2] ?? 'architecture';
const targetIndex = process.argv.indexOf('--target-root');
const targetRoot = targetIndex >= 0 ? process.argv[targetIndex + 1] : process.cwd();
try { if (!targetRoot) throw new Error('TARGET_ROOT_REQUIRED'); const result = command === 'placeholders' ? await scanPlaceholders(targetRoot) : command === 'prohibited' ? await scanProhibitedCapabilities(targetRoot) : await verifyArchitecture(targetRoot); console.log(JSON.stringify({ command, status: 'PASS', ...result })); } catch (error) { console.error(JSON.stringify({ command, status: 'FAIL', error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; }
