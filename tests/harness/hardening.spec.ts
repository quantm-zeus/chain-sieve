import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  buildImplementationBrief,
  classifyReferencedPaths,
  exactNormativeExcerpts,
  partitionAcceptanceCriteria,
  rejectDuplicateContextReferences,
} from '../../tools/prd-compiler/hardening.js';

describe('context, acceptance partition, and specification hardening', () => {
  it('extracts exact nearby normative source text', () => {
    const excerpts = exactNormativeExcerpts('one\ntwo\nMUST exact\nfour\nfive', [{ id: 'FR-X-001', text: 'exact', textSha256: 'a', line: 3, owner: 'packages/x', dependencyGroup: 'G0', implementationRefs: [], schemaRefs: [], persistenceRefs: [], apiToolUiRefs: [], testRefs: [], fixtureRefs: [], telemetryRefs: [], rollbackRefs: [], activationGateRefs: [] }], []);
    expect(excerpts[0]).toMatchObject({ sourceLine: 3, exactText: 'one\ntwo\nMUST exact\nfour\nfive' });
  });

  it('deduplicates path classification and rejects duplicate context-manifest references', () => {
    const requirement = { id: 'FR-X-001', text: 'Detailed input output schema returns an explicit result with failure status.', textSha256: 'a', line: 1, owner: 'packages/x', dependencyGroup: 'G0', implementationRefs: ['packages/x/** @requirement FR-X-001', 'packages/x/** @requirement FR-X-001'], schemaRefs: ['packages/x/src/schema.ts'], persistenceRefs: [], apiToolUiRefs: [], testRefs: [], fixtureRefs: [], telemetryRefs: [], rollbackRefs: [], activationGateRefs: [] };
    const references = classifyReferencedPaths([requirement], { id: 'T-G0-X', cluster: 'C-G0-X', requirements: ['FR-X-001'], ownerPackages: ['packages/x'], writeSet: ['packages/x/**'], allowedPaths: ['packages/x/**'] }, []);
    expect(references.filter((item) => item.path === 'packages/x/**')).toHaveLength(1);
    expect(references.every((item) => item.status === 'EXPECTED_TO_CREATE')).toBe(true);
    expect(() => rejectDuplicateContextReferences([{ path: 'a.json' }, { path: 'a.json' }])).toThrow('DUPLICATE_CONTEXT_REFERENCE');
  });

  it('blocks underspecified interfaces and invalid references', () => {
    const requirement = { id: 'FR-X-001', text: 'Terse registry.', textSha256: 'a', line: 1, owner: 'packages/x', dependencyGroup: 'G0', implementationRefs: ['packages/x/**'], schemaRefs: [], persistenceRefs: [], apiToolUiRefs: [], testRefs: [], fixtureRefs: [], telemetryRefs: [], rollbackRefs: [], activationGateRefs: [] };
    expect(buildImplementationBrief('T-G0-X', [requirement], [{ path: 'bad/path', status: 'INVALID_REFERENCE' }])).toMatchObject({ specificationStatus: 'SPECIFICATION_GAP' });
  });

  it('detects cross-task, cluster, and project acceptance levels', () => {
    const criteria = [
      { id: 'AC-T', text: 'local', textSha256: 'a', line: 1, requirementRefs: ['FR-A'], positiveTestRef: 'p', negativeOrFailureTestRef: 'n' },
      { id: 'AC-C', text: 'cluster', textSha256: 'b', line: 2, requirementRefs: ['FR-A', 'FR-B'], positiveTestRef: 'p', negativeOrFailureTestRef: 'n' },
      { id: 'AC-P', text: 'project', textSha256: 'c', line: 3, requirementRefs: ['FR-A', 'FR-C'], positiveTestRef: 'p', negativeOrFailureTestRef: 'n' },
    ];
    const tasks = [
      { id: 'T-A', cluster: 'C-G0-X', requirements: ['FR-A'], ownerPackages: ['a'] },
      { id: 'T-B', cluster: 'C-G0-X', requirements: ['FR-B'], ownerPackages: ['b'] },
      { id: 'T-C', cluster: 'C-G1-X', requirements: ['FR-C'], ownerPackages: ['c'] },
    ];
    expect(partitionAcceptanceCriteria(criteria, tasks).map((item) => item.level)).toEqual(['TASK', 'CLUSTER', 'PROJECT']);
  });

  it('assigns AC-001 and AC-245 above T-G0-CORE without changing normative text', async () => {
    const partition = JSON.parse(await readFile('artifacts/spec/acceptance-partition.json', 'utf8')) as { assignments: Array<{ acceptanceId: string; level: string; sourceText: string }> };
    const source = JSON.parse(await readFile('docs/spec/crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.requirements.json', 'utf8')) as { acceptanceCriteria: Array<{ id: string; text: string }> };
    for (const id of ['AC-001', 'AC-245']) {
      const assignment = partition.assignments.find((item) => item.acceptanceId === id)!;
      expect(assignment.level).toBe('PROJECT');
      expect(assignment.sourceText).toBe(source.acceptanceCriteria.find((item) => item.id === id)!.text);
    }
    const core = JSON.parse(await readFile('tasks/G0/T-G0-CORE.contract.json', 'utf8')) as { acceptanceCriteria: string[]; taskAcceptanceFacets: Array<{ acceptanceId: string; text: string }> };
    expect(core.acceptanceCriteria).not.toContain('AC-001');
    expect(core.acceptanceCriteria).not.toContain('AC-245');
    expect(core.taskAcceptanceFacets.find((item) => item.acceptanceId === 'AC-001')?.text).toContain('does not claim full AC-001 satisfaction');
    expect(core.taskAcceptanceFacets.find((item) => item.acceptanceId === 'AC-245')?.text).toContain('does not claim full AC-245 satisfaction');
  });
});
