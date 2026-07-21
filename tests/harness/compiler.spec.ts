import { describe, expect, it } from 'vitest';
import { compile, driftCheck, loadAndValidateSpecification, sha256 } from '../../tools/prd-compiler/compiler.js';
import { deriveEvidenceVerdict, verifyCoverage } from '../../tools/task-verifier/verify.js';

describe('deterministic PRD compiler', () => {
  it('independently validates authoritative sources', async () => { const specification = await loadAndValidateSpecification(); expect(specification.manifest.requirements).toHaveLength(397); expect(specification.manifest.acceptanceCriteria).toHaveLength(204); expect(specification.issues).toEqual([]); });
  it('reproduces identical aggregate hashes', async () => { const first = await compile(); const second = await compile(); expect(second.aggregateHash).toBe(first.aggregateHash); expect(second.tasks).toBeGreaterThan(60); expect(second.clusters).toBe(8); await expect(driftCheck()).resolves.toMatchObject({ aggregateHash: first.aggregateHash }); });
  it('maps every requirement and acceptance criterion', async () => { await expect(verifyCoverage()).resolves.toMatchObject({ requirements: 397, acceptanceCriteria: 204 }); });
  it('rejects completion forgery rather than trusting PASS', () => { expect(() => deriveEvidenceVerdict(['pnpm test'], [{ command: 'pnpm test', exitCode: 0, output: 'PASS', outputSha256: sha256('PASS') }])).toThrow('UNSUBSTANTIATED_COMMAND_EVIDENCE'); expect(() => deriveEvidenceVerdict(['pnpm test'], [{ command: 'pnpm test', exitCode: 0, output: '12 tests passed in 1.3s', outputSha256: 'forged' }])).toThrow('FORGED_COMMAND_EVIDENCE'); });
});
