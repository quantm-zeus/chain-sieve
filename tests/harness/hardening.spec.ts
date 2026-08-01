import { readFile, readdir } from 'node:fs/promises';
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

  it('requires deterministic ownership evidence for future paths', () => {
    const requirement = { id: 'FR-X-001', text: 'Detailed input output schema returns an explicit result with failure status.', textSha256: 'a', line: 1, owner: 'packages/x', dependencyGroup: 'G0', implementationRefs: [], schemaRefs: [], persistenceRefs: [], apiToolUiRefs: [], testRefs: [], fixtureRefs: [], telemetryRefs: [], rollbackRefs: [], activationGateRefs: [] };
    const task = { id: 'T-G0-X', cluster: 'C-G0-X', requirements: ['FR-X-001'], ownerPackages: ['packages/x'], writeSet: ['packages/x/**'], allowedPaths: ['packages/x/**'], forbiddenPaths: ['docs/spec/**', 'infra/migrations/**'], changeBudget: { maxMigrations: 0 } };
    const classify = (path: string, allTasks: typeof task[] = []) => classifyReferencedPaths([{ ...requirement, implementationRefs: [path] }], task, [task, ...allTasks])[0]!;
    expect(classify('packagess/x/typo.ts').status).toBe('INVALID_REFERENCE');
    expect(classify('docs/spec/forbidden.md').status).toBe('INVALID_REFERENCE');
    expect(classify('packages/y/src/output.ts', [{ ...task, id: 'T-G0-Y', ownerPackages: ['packages/y'], writeSet: ['packages/y/**'], allowedPaths: ['packages/y/**'], forbiddenPaths: [] }])).toMatchObject({ status: 'OWNED_BY_OTHER_TASK', ownerTask: 'T-G0-Y' });
    expect(classify('migrations/g0_x_*.sql').status).toBe('SPECIFICATION_GAP');
    expect(classify('packages/x/src/output.ts').status).toBe('EXPECTED_TO_CREATE');
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

  it('accounts for every task exactly once and never schedules a specification gap', async () => {
    const queue = JSON.parse(await readFile('tasks/generated/ready-queue.json', 'utf8')) as {
      counts: { total: number; implementationReady: number; specificationGap: number };
      ready: string[];
      blocked: Array<{ taskId: string; reason: string }>;
    };
    expect(queue.counts).toEqual({ total: 84, implementationReady: 71, specificationGap: 13 });
    const scheduled = [
      ...queue.ready,
      ...queue.blocked.map((item) => item.taskId),
    ];
    expect(new Set(scheduled).size).toBe(84);
    expect(scheduled).toHaveLength(84);
    const gaps = queue.blocked.filter((item) => item.reason === 'SPECIFICATION_GAP');
    expect(gaps).toHaveLength(13);
    expect(queue.ready.some((taskId) => gaps.some((item) => item.taskId === taskId))).toBe(false);
    expect(gaps.some((item) => item.taskId === 'T-G0-CORE')).toBe(true);
  });

  it('keeps all 2,439 path references exactly classified', async () => {
    const statuses: string[] = [];
    for (const taskId of (await readdir('artifacts/context')).filter((name) => /^T-G[0-7]-/.test(name))) {
      const path = `artifacts/context/${taskId}/referenced-path-status.json`;
      const references = JSON.parse(await readFile(path, 'utf8')) as Array<{ status: string }>;
      statuses.push(...references.map((item) => item.status));
    }
    expect(statuses).toHaveLength(2_439);
    expect(statuses.reduce<Record<string, number>>((counts, status) => {
      counts[status] = (counts[status] ?? 0) + 1;
      return counts;
    }, {})).toEqual({
      OWNED_BY_OTHER_TASK: 187,
      SPECIFICATION_GAP: 2_188,
      EXISTS: 33,
      EXPECTED_TO_CREATE: 31,
    });
  });
});
