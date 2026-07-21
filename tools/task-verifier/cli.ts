import { driftCheck, loadAndValidateSpecification } from '../prd-compiler/compiler.js';
import { verifyCoverage, verifyHarness, verifyTaskContract } from './verify.js';

const command = process.argv[2] ?? 'harness';
try { const result = command === 'spec:verify' ? await loadAndValidateSpecification().then((spec) => ({ sourceHashes: spec.hashes, counts: { requirements: spec.manifest.requirements.length, acceptanceCriteria: spec.manifest.acceptanceCriteria.length } })) : command === 'coverage' ? await verifyCoverage() : command === 'task' ? await verifyTaskContract(process.argv[3] ?? '') : command === 'drift' ? await driftCheck() : await verifyHarness(); console.log(JSON.stringify({ command, status: 'PASS', result }, null, 2)); } catch (error) { console.error(JSON.stringify({ command, status: 'FAIL', error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; }
