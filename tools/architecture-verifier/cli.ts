import { scanPlaceholders, scanProhibitedCapabilities, verifyArchitecture } from './verify.js';
const command = process.argv[2] ?? 'architecture';
try { const result = command === 'placeholders' ? await scanPlaceholders() : command === 'prohibited' ? await scanProhibitedCapabilities() : await verifyArchitecture(); console.log(JSON.stringify({ command, status: 'PASS', ...result })); } catch (error) { console.error(JSON.stringify({ command, status: 'FAIL', error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; }
