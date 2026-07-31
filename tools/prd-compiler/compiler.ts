import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { ClusterContractSchema, ContractSchemas, TaskContractSchema, type ClusterContract, type TaskContract } from '@ciag/shared-schemas';
import {
  behaviorTestMatrix,
  buildConformanceManifest,
  buildImplementationBrief,
  classifyReferencedPaths,
  exactNormativeExcerpts,
  interfacePlan,
  partitionAcceptanceCriteria,
  taskFacet,
  type AcceptanceAssignment,
  type HardeningAcceptance,
  type HardeningRequirement,
} from './hardening.js';

const ROOT = resolve(process.cwd());
const COMPILE_LOCK = join(ROOT, 'node_modules/.cache/ciag-prd-compile.lock');
const SPEC = join(ROOT, 'docs/spec');
const PRD = join(SPEC, 'crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.md');
const MANIFEST = join(SPEC, 'crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.requirements.json');
const AUDIT = join(SPEC, 'crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.audit.json');
export const SOURCE_PATHS = { prd: PRD, requirements: MANIFEST, audit: AUDIT } as const;

const RequirementSchema = z.object({ id: z.string(), text: z.string(), textSha256: z.string(), line: z.number(), family: z.string(), dependencyGroup: z.string(), owner: z.string(), normativeLevel: z.string(), acceptanceCriteria: z.array(z.string()), implementationRefs: z.array(z.string()), schemaRefs: z.array(z.string()), persistenceRefs: z.array(z.string()), apiToolUiRefs: z.array(z.string()), testRefs: z.array(z.string()), fixtureRefs: z.array(z.string()), telemetryRefs: z.array(z.string()), securityRightsCostControls: z.array(z.string()), activationGateRefs: z.array(z.string()), rollbackRefs: z.array(z.string()) }).passthrough();
const AcceptanceSchema = z.object({ id: z.string(), text: z.string(), textSha256: z.string(), line: z.number(), requirementRefs: z.array(z.string()), positiveTestRef: z.string(), negativeOrFailureTestRef: z.string() }).passthrough();
const ManifestSchema = z.object({ schemaVersion: z.string(), document: z.object({ documentId: z.string(), version: z.string(), generatedAt: z.string(), normalizedSha256: z.string() }).passthrough(), requirements: z.array(RequirementSchema), acceptanceCriteria: z.array(AcceptanceSchema), invariants: z.array(z.object({ id: z.string(), text: z.string(), textSha256: z.string(), line: z.number() }).passthrough()), adrs: z.array(z.object({ id: z.string(), title: z.string(), decision: z.string(), textSha256: z.string(), line: z.number() }).passthrough()), dependencyGroups: z.array(z.object({ id: z.string(), name: z.string(), dependsOn: z.array(z.string()) })), releaseConformance: z.record(z.string(), z.unknown()) });
type Manifest = z.infer<typeof ManifestSchema>;
type SourceHashes = { prd: string; requirements: string; audit: string };
type OutputMap = Map<string, string>;

export const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const pause = async (milliseconds: number): Promise<void> => new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));
export const waitForCompilerIdle = async (): Promise<void> => { for (let attempt = 0; attempt < 400; attempt += 1) { try { const info = await stat(COMPILE_LOCK); if (Date.now() - info.mtimeMs > 120_000) { await rm(COMPILE_LOCK, { recursive: true, force: true }); continue; } } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; } await pause(25); } throw new Error('PRD_COMPILER_LOCK_TIMEOUT'); };
const acquireCompilerLock = async (): Promise<void> => { await mkdir(dirname(COMPILE_LOCK), { recursive: true }); for (let attempt = 0; attempt < 400; attempt += 1) { try { await mkdir(COMPILE_LOCK); await writeFile(join(COMPILE_LOCK, 'owner.json'), `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`); return; } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await waitForCompilerIdle(); } } throw new Error('PRD_COMPILER_LOCK_TIMEOUT'); };
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const unique = <T>(values: T[]): T[] => [...new Set(values)];
const idSet = <T extends { id: string }>(values: T[], label: string): Set<string> => { const ids = values.map((value) => value.id); const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index); if (duplicates.length > 0) throw new Error(`DUPLICATE_${label}_IDS:${unique(duplicates).join(',')}`); return new Set(ids); };
const safeId = (value: string): string => value.toUpperCase().replace(/^FR-/, '').replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');

export interface ValidatedSpecification { manifest: Manifest; prd: string; audit: Record<string, unknown>; hashes: SourceHashes; issues: string[] }

export const loadAndValidateSpecification = async (): Promise<ValidatedSpecification> => {
  const [prd, manifestText, auditText] = await Promise.all([readFile(PRD, 'utf8'), readFile(MANIFEST, 'utf8'), readFile(AUDIT, 'utf8')]);
  const manifest = ManifestSchema.parse(JSON.parse(manifestText));
  const audit = z.record(z.string(), z.unknown()).parse(JSON.parse(auditText));
  const hashes = { prd: sha256(prd), requirements: sha256(manifestText), audit: sha256(auditText) };
  const auditHashes = z.object({ documentArtifactSha256: z.string(), requirementManifestSha256: z.string() }).parse(audit.hashes);
  const issues: string[] = [];
  if (auditHashes.documentArtifactSha256 !== hashes.prd) issues.push('PRD_AUDIT_HASH_MISMATCH');
  if (auditHashes.requirementManifestSha256 !== hashes.requirements) issues.push('MANIFEST_AUDIT_HASH_MISMATCH');
  if (manifest.requirements.length !== 397) issues.push('REQUIREMENT_COUNT_MISMATCH');
  if (manifest.acceptanceCriteria.length !== 204) issues.push('ACCEPTANCE_COUNT_MISMATCH');
  if (manifest.invariants.length !== 44) issues.push('INVARIANT_COUNT_MISMATCH');
  if (manifest.adrs.length !== 58) issues.push('ADR_COUNT_MISMATCH');
  const requirementIds = idSet(manifest.requirements, 'REQUIREMENT');
  const acceptanceIds = idSet(manifest.acceptanceCriteria, 'ACCEPTANCE');
  const invariantIds = idSet(manifest.invariants, 'INVARIANT');
  idSet(manifest.adrs, 'ADR'); idSet(manifest.dependencyGroups, 'GROUP');
  for (const requirement of manifest.requirements) {
    if (!/^FR-[A-Z0-9]+-\d{3}$/.test(requirement.id)) issues.push(`MALFORMED_ID:${requirement.id}`);
    if (sha256(requirement.text) !== requirement.textSha256) issues.push(`REQUIREMENT_TEXT_HASH:${requirement.id}`);
    if (!manifest.dependencyGroups.some((group) => group.id === requirement.dependencyGroup)) issues.push(`INVALID_GROUP:${requirement.id}`);
    if (requirement.owner.length === 0) issues.push(`MISSING_OWNER:${requirement.id}`);
    if (requirement.activationGateRefs.length === 0) issues.push(`MISSING_ACTIVATION_GATE:${requirement.id}`);
    for (const id of requirement.acceptanceCriteria) if (!acceptanceIds.has(id)) issues.push(`INVALID_AC_REF:${requirement.id}:${id}`);
    for (const ref of requirement.securityRightsCostControls.filter((value) => value.startsWith('INV-'))) if (!invariantIds.has(ref)) issues.push(`INVALID_INVARIANT_REF:${requirement.id}:${ref}`);
  }
  for (const acceptance of manifest.acceptanceCriteria) {
    if (sha256(acceptance.text) !== acceptance.textSha256) issues.push(`ACCEPTANCE_TEXT_HASH:${acceptance.id}`);
    if (acceptance.requirementRefs.length === 0) issues.push(`ORPHAN_ACCEPTANCE:${acceptance.id}`);
    for (const ref of acceptance.requirementRefs) if (!requirementIds.has(ref)) issues.push(`INVALID_REQUIREMENT_REF:${acceptance.id}:${ref}`);
  }
  for (const requirement of manifest.requirements) if (!manifest.acceptanceCriteria.some((acceptance) => acceptance.requirementRefs.includes(requirement.id))) issues.push(`ORPHAN_REQUIREMENT:${requirement.id}`);
  const groups = new Map(manifest.dependencyGroups.map((group) => [group.id, group.dependsOn]));
  const visit = (id: string, path: string[]): void => { if (path.includes(id)) { issues.push(`DEPENDENCY_GROUP_CYCLE:${[...path, id].join('>')}`); return; } for (const dependency of groups.get(id) ?? []) { if (!groups.has(dependency)) issues.push(`INVALID_GROUP_DEPENDENCY:${id}:${dependency}`); else visit(dependency, [...path, id]); } };
  for (const id of groups.keys()) visit(id, []);
  if (/\{\{[^}]+\}\}|<TBD>/.test(prd)) issues.push('UNRESOLVED_PLACEHOLDER');
  if (issues.length > 0) throw new Error(`SPECIFICATION_INTEGRITY_FAILED\n${issues.join('\n')}`);
  return { manifest, prd, audit, hashes, issues };
};

const extractApi = (prd: string): { method: string; path: string; line: number }[] => {
  const routes: { method: string; path: string; line: number }[] = [];
  const start = prd.indexOf('## 29. API contract'); const end = prd.indexOf('## 30.', start); const segment = prd.slice(start, end); const offset = prd.slice(0, start).split('\n').length - 1;
  for (const [index, line] of segment.split('\n').entries()) {
    const match = /^(GET|POST|PATCH|DELETE|PUT)(?:\/(GET|POST|PATCH|DELETE|PUT))?\s+(\/api\/v1\S+|\/mcp)\b/.exec(line.trim());
    if (!match?.[1] || !match[3]) continue;
    routes.push({ method: match[1], path: match[3], line: offset + index + 1 });
    if (match[2]) routes.push({ method: match[2], path: match[3], line: offset + index + 1 });
  }
  const keys = routes.map((route) => `${route.method} ${route.path}`);
  const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
  if (duplicate) throw new Error(`DUPLICATE_API_ROUTE:${duplicate}`);
  return routes;
};

const extractPersistence = (prd: string): { name: string; line: number }[] => {
  const start = prd.indexOf('## 30. Core persistence model'); const end = prd.indexOf('## 31.', start); const segment = prd.slice(start, end); const offset = prd.slice(0, start).split('\n').length - 1;
  const values: { name: string; line: number }[] = [];
  let fenced = false;
  for (const [index, raw] of segment.split('\n').entries()) { const line = raw.trim(); if (line.startsWith('```')) { fenced = !fenced; continue; } if (fenced && /^[a-z][a-z0-9_]+$/.test(line)) values.push({ name: line, line: offset + index + 1 }); }
  const duplicate = values.map((value) => value.name).find((name, index, all) => all.indexOf(name) !== index); if (duplicate) throw new Error(`DUPLICATE_PERSISTENCE_ENTITY:${duplicate}`); return values;
};

const makeTasks = (
  spec: ValidatedSpecification,
  baselinePaths: string[],
): { tasks: TaskContract[]; acceptancePartition: AcceptanceAssignment[] } => {
  const byKey = new Map<string, Manifest['requirements']>();
  for (const requirement of spec.manifest.requirements) { const key = `${requirement.dependencyGroup}|${requirement.family}|${requirement.owner}`; byKey.set(key, [...(byKey.get(key) ?? []), requirement]); }
  const entries = [...byKey.entries()].flatMap(([key, requirements]) => { const [group, family] = key.split('|') as [string, string]; const chunks = Array.from({ length: Math.ceil(requirements.length / 8) }, (_, index) => requirements.slice(index * 8, index * 8 + 8)); return chunks.map((chunk, index) => ({ key, requirements: chunk, id: `T-${group}-${safeId(family)}${chunks.length > 1 ? `-${String(index + 1).padStart(2, '0')}` : ''}` })); });
  const byGroup = new Map<string, string[]>();
  for (const entry of entries) { const group = entry.key.split('|')[0] as string; byGroup.set(group, [...(byGroup.get(group) ?? []), entry.id]); }
  const tasks = entries.map(({ key, requirements, id }) => {
    const [group, family, owner] = key.split('|') as [string, string, string];
    const groupDefinition = spec.manifest.dependencyGroups.find((value) => value.id === group);
    const invariantRefs = unique(requirements.flatMap((requirement) => requirement.securityRightsCostControls.filter((ref) => ref.startsWith('INV-'))));
    const riskLevel = /SEC|EXEC|PROD|LEGAL|ALAB|ADG/.test(family) ? 'CRITICAL' as const : requirements.length >= 6 ? 'HIGH' as const : 'MEDIUM' as const;
    const writeSet = unique(requirements.flatMap((requirement) => requirement.implementationRefs.map((ref) => ref.split(' ')[0] as string)));
    const ownsMigrations = owner === 'packages/persistence';
    return TaskContractSchema.parse({
      schemaVersion: '1.0.0', id, title: `${family} implementation contract`, sourceHashes: spec.hashes, dependencyGroup: group, cluster: `C-${group}-IMPLEMENTATION`, riskLevel, autonomyLevel: riskLevel === 'CRITICAL' ? 'OWNER_APPROVAL_REQUIRED' : riskLevel === 'HIGH' ? 'REVIEW_REQUIRED' : 'AUTONOMOUS', dependencies: unique((groupDefinition?.dependsOn ?? []).flatMap((dependency) => byGroup.get(dependency) ?? [])).sort(), requirements: requirements.map((requirement) => requirement.id), acceptanceCriteria: [], taskAcceptanceFacets: [], invariants: invariantRefs.length > 0 ? invariantRefs : ['INV-001', 'INV-044'], adrs: ['ADR-001'], ownerPackages: [owner], readSet: ['docs/spec/**', 'artifacts/context/' + id + '/**', `artifacts/conformance/${id}/manifest.json`], writeSet, allowedPaths: unique([...writeSet, 'tests/acceptance/**', 'tests/negative/**', 'tests/task-facets/**', 'tests/fixtures/**', 'docs/implementation/**', ...(ownsMigrations ? ['infra/migrations/**'] : [])]), forbiddenPaths: ['docs/spec/**', 'artifacts/spec/**', 'tasks/generated/**', '.github/workflows/**', 'tests/conformance/**', `artifacts/conformance/${id}/**`, ...(!ownsMigrations ? ['infra/migrations/**'] : [])], exclusiveLocks: ownsMigrations ? ['infra/migrations'] : [`${owner}/public-api`], interfaceHashes: { [`${owner}:contract`]: sha256(requirements.map((requirement) => `${requirement.id}:${requirement.textSha256}`).join('\n')) }, deliverables: unique(requirements.flatMap((requirement) => requirement.implementationRefs)).slice(0, 30).concat([`${owner} implementation and tests`]), constraints: ['Preserve every referenced normative ID and degraded behavior.', 'Keep product influence disabled until explicit activation gates pass.', 'Use point-in-time and evidence semantics where externally sourced data is involved.', 'Do not modify the control-plane-owned immutable conformance oracle.'], nonGoals: ['No financial execution, signing, custody, or transaction submission.', 'No automatic alpha or product capability activation.', 'No unrelated dependency-group implementation.'], degradedBehavior: 'Fail closed or return NOT_AVAILABLE/INSUFFICIENT_DATA with provenance; never fabricate success.', rollback: 'Revert the single atomic task commit and restore the prior schema/config artifact; migrations require a forward compensating migration.', requiredTests: [], verificationCommands: [{ command: 'pnpm exec vitest run tests/conformance/task-oracle.spec.ts', expected: 'immutable conformance and test-quality oracle passes' }, { command: 'pnpm architecture:verify', expected: 'all architecture fitness controls pass' }, { command: 'pnpm prohibited-capabilities:scan', expected: 'no prohibited executable capability' }], complexityBudget: { maxFiles: 24, maxChangedLines: 1800, maxCyclomaticComplexity: 12 }, changeBudget: { maxMigrations: ownsMigrations ? 3 : 0, maxPublicInterfaces: 4, requiresSplitAboveBudget: true }, stopConditions: ['A source hash differs from the task contract.', 'A dependency is not MERGED or its public interface hash changed.', 'Required behavior exceeds a declared budget without an approved split.', 'A prohibited capability or activation path would be introduced.', 'The implementation brief reports SPECIFICATION_GAP or an invalid reference.'], completionDefinition: ['All mapped positive and negative task-owned tests pass.', 'The immutable conformance and test-quality oracle passes.', 'Deterministic verifier derives PASS from repository evidence.', 'One atomic task commit exists and architecture checks pass.', 'Degraded, replay, rollback, and observability behavior is documented and tested.'], sourceReferences: requirements.map((requirement) => ({ path: 'docs/spec/crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.md', line: requirement.line, id: requirement.id })), specificationStatus: 'READY', testQualityGate: riskLevel === 'HIGH' || riskLevel === 'CRITICAL' ? 'SEEDED_FAULT_OR_PROPERTY' : 'NEGATIVE_CASE',
    });
  }).sort((a, b) => a.id.localeCompare(b.id));
  const acceptancePartition = partitionAcceptanceCriteria(
    spec.manifest.acceptanceCriteria as HardeningAcceptance[],
    tasks,
  );
  for (const assignment of acceptancePartition) {
    const criterion = spec.manifest.acceptanceCriteria.find((item) => item.id === assignment.acceptanceId)!;
    if (assignment.level === 'TASK') {
      const owner = tasks.find((task) => task.id === assignment.owner)!;
      owner.acceptanceCriteria.push(criterion.id);
      owner.requiredTests.push(criterion.positiveTestRef, criterion.negativeOrFailureTestRef);
      continue;
    }
    for (const taskId of assignment.participatingTasks) {
      const owner = tasks.find((task) => task.id === taskId)!;
      owner.taskAcceptanceFacets.push(taskFacet(assignment, owner));
    }
  }
  const hardened = tasks.map((task) => {
    if (task.taskAcceptanceFacets.length > 0)
      task.requiredTests.push(
        `tests/task-facets/${task.id}.spec.ts`,
        `tests/task-facets/${task.id}.negative.spec.ts`,
      );
    task.requiredTests = unique(task.requiredTests);
    const requirements = spec.manifest.requirements.filter((item) => task.requirements.includes(item.id)) as HardeningRequirement[];
    const references = classifyReferencedPaths(requirements, task, tasks, { baselinePaths });
    const brief = buildImplementationBrief(task.id, requirements, references);
    const conformance = buildConformanceManifest({
      taskId: task.id,
      riskLevel: task.riskLevel,
      requirements: task.requirements,
      taskAcceptanceCriteria: task.acceptanceCriteria,
      taskAcceptanceFacets: task.taskAcceptanceFacets,
      requiredTests: task.requiredTests,
      productionTargets: task.writeSet,
    });
    const conformanceManifestPath = `artifacts/conformance/${task.id}/manifest.json`;
    return TaskContractSchema.parse({
      ...task,
      specificationStatus: brief.specificationStatus,
      conformanceManifestPath,
      conformanceManifestSha256: conformance.sha256,
      verificationCommands: [
        { command: `pnpm exec vitest run ${task.requiredTests.join(' ')}`, expected: 'all task-owned positive and negative tests execute with zero skips' },
        { command: 'pnpm exec vitest run tests/conformance/task-oracle.spec.ts', expected: 'immutable conformance and test-quality oracle passes' },
        { command: 'pnpm architecture:verify', expected: 'all architecture fitness controls pass' },
        { command: 'pnpm prohibited-capabilities:scan', expected: 'no prohibited executable capability' },
      ],
    });
  });
  return { tasks: hardened, acceptancePartition };
};

const makeClusters = (spec: ValidatedSpecification, tasks: TaskContract[], acceptancePartition: AcceptanceAssignment[]): ClusterContract[] => spec.manifest.dependencyGroups.map((group) => {
  const grouped = tasks.filter((task) => task.dependencyGroup === group.id); const clusterId = `C-${group.id}-IMPLEMENTATION`; const integrationAcceptanceCriteria = acceptancePartition.filter((item) => item.level === 'CLUSTER' && item.owner === clusterId).map((item) => item.acceptanceId); return ClusterContractSchema.parse({ schemaVersion: '1.0.0', id: clusterId, group: group.id, title: group.name, sourceHashes: spec.hashes, dependencies: group.dependsOn.map((id) => `C-${id}-IMPLEMENTATION`), tasks: grouped.map((task) => task.id), requirements: unique(grouped.flatMap((task) => task.requirements)), acceptanceCriteria: unique([...grouped.flatMap((task) => task.acceptanceCriteria), ...integrationAcceptanceCriteria]), integrationAcceptanceCriteria, invariants: unique(grouped.flatMap((task) => task.invariants)), entryCriteria: ['All dependency clusters have independent PASS reviews.', 'Source hashes match and task ready queue is current.'], exitCriteria: ['Every task is independently verified and atomically committed.', 'Every cluster-level integration acceptance criterion passes its immutable oracle.', 'Cluster integration, architecture, security, migration, and replay checks pass.', 'Independent agent-neutral cluster review records PASS.'], verificationCommands: [{ command: `pnpm cluster:verify ${clusterId}`, expected: 'exit 0' }, { command: 'pnpm harness:verify', expected: 'exit 0' }], rollback: 'Revert cluster task commits in reverse dependency order; capability state remains disabled or shadow.' });
});

const goalMarkdown = (cluster: ClusterContract, mode: 'agent-goal' | 'codex-review' | 'agent-fix-goal'): string => {
  const action = mode === 'agent-goal' ? 'Implement each READY task one at a time' : mode === 'codex-review' ? 'Independently review the completed cluster and produce PASS or CHANGES_REQUIRED' : 'Fix only the findings in the latest cluster review';
  return `# ${cluster.id} ${mode}\n\n${action}. The immutable contract is \`${cluster.id}.contract.json\`. Validate source hashes before work. Work only on \`cluster/${cluster.group.toLowerCase()}\`; create it from the current verified baseline if it does not exist. Never switch to or merge into \`main\`.\n\nTasks, in contract order:\n${cluster.tasks.map((task) => `- \`${task}\``).join('\n')}\n\nFor every task, sequentially: run \`pnpm worktree:create <task-id>\`; enter the returned isolated worktree; run \`pnpm task:acquire <task-id> --holder agent-orchestrator\` and retain its lease version; run \`pnpm task:begin <task-id> --holder agent-orchestrator --lease-version <version>\`; implement only the contract IDs and allowed paths; run targeted development tests; create exactly one atomic commit; self-review the complete committed diff; run \`pnpm task:self-review <task-id> --holder agent-orchestrator --lease-version <version>\`; then stop. The clean root control plane performs authoritative verification, merge-queue processing, and cleanup. Use only explicit root \`pnpm agent:renew -- <task-id> --expected-lease-id <lease-id> --expected-fencing-version <version> --holder <holder>\` or \`pnpm agent:recover -- <task-id> ...\` lifecycle operations; implementation agents never renew or recover credentials. Stop on hash drift, stale/lost lease, path conflict, specification gap, budget breach, prohibited capability, failed verification, or unmet dependency. Never activate product or alpha capability.\n\nAfter all tasks are atomically merged, the root control plane runs \`pnpm cluster:verify ${cluster.id}\`, freezes the cluster result, and only then requests a separate independent review before \`pnpm cluster:report ${cluster.id}\`.\n`;
};

const requiredGoalArguments: Record<string, RegExp> = {
  'worktree:create': /^<task-id>$/, 'task:acquire': /^<task-id> --holder [a-z0-9-]+$/, 'task:begin': /^<task-id> --holder [a-z0-9-]+ --lease-version <version>$/, 'task:self-review': /^<task-id> --holder [a-z0-9-]+ --lease-version <version>$/, 'task:verify': /^<task-id> --holder [a-z0-9-]+ --lease-version <version>$/, 'merge-queue:add': /^<task-id>$/, 'merge-queue:process': /^$/, 'cluster:verify': /^C-G[0-7]-[A-Z0-9-]+$/, 'cluster:report': /^C-G[0-7]-[A-Z0-9-]+$/,
};
export const validateGeneratedGoalCommands = (goal: string, scripts: Record<string, string>): string[] => {
  const commands = [...goal.matchAll(/`pnpm ([a-z0-9:-]+)(?: ([^`]+))?`/g)].map((match) => ({ script: match[1]!, args: (match[2] ?? '').trim() }));
  if (commands.length === 0) throw new Error('GENERATED_GOAL_COMMANDS_MISSING');
  for (const command of commands) { if (!scripts[command.script]) throw new Error(`UNKNOWN_GENERATED_COMMAND:${command.script}`); if (['task:verify', 'merge-queue:add', 'merge-queue:process'].includes(command.script)) throw new Error(`IMPLEMENTATION_GOAL_ROOT_ACTION_PROHIBITED:${command.script}`); const required = requiredGoalArguments[command.script]; if (required && !required.test(command.args)) throw new Error(`INVALID_GENERATED_COMMAND_ARGUMENTS:${command.script}:${command.args}`); }
  const lifecycle = ['task:acquire', 'task:begin', 'task:self-review', 'cluster:verify', 'cluster:report']; const positions = lifecycle.map((script) => commands.findIndex((command) => command.script === script)); if (positions.some((position) => position < 0) || positions.some((position, index) => index > 0 && position <= positions[index - 1]!)) throw new Error('INVALID_GENERATED_GOAL_STATE_TRANSITIONS');
  return commands.map((command) => `pnpm ${command.script}${command.args ? ` ${command.args}` : ''}`);
};

const fixedBaselinePaths = (): string[] => {
  const result = spawnSync('git', ['ls-tree', '-r', '--name-only', 'harness-v1.0.1'], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`CONFORMANCE_BASELINE_UNAVAILABLE:${result.stderr.trim()}`);
  return result.stdout.split('\n').filter(Boolean).sort();
};

const buildOutputs = async (spec: ValidatedSpecification): Promise<OutputMap> => {
  const outputs: OutputMap = new Map(); const baselinePaths = fixedBaselinePaths(); const { tasks, acceptancePartition } = makeTasks(spec, baselinePaths); const clusters = makeClusters(spec, tasks, acceptancePartition); const api = extractApi(spec.prd); const persistence = extractPersistence(spec.prd);
  const requirementTaskMap = Object.fromEntries(spec.manifest.requirements.map((requirement) => [requirement.id, tasks.filter((task) => task.requirements.includes(requirement.id)).map((task) => task.id)]));
  const acceptanceTaskMap = Object.fromEntries(acceptancePartition.map((assignment) => [assignment.acceptanceId, [assignment.owner]]));
  const coverage = { requirements: { total: spec.manifest.requirements.length, mapped: Object.values(requirementTaskMap).filter((ids) => ids.length > 0).length }, acceptanceCriteria: { total: spec.manifest.acceptanceCriteria.length, mapped: Object.values(acceptanceTaskMap).filter((ids) => ids.length > 0).length } };
  if (coverage.requirements.total !== coverage.requirements.mapped || coverage.acceptanceCriteria.total !== coverage.acceptanceCriteria.mapped) throw new Error('INCOMPLETE_COVERAGE');
  if (Object.values(acceptanceTaskMap).some((ids) => ids.length !== 1)) throw new Error('ACCEPTANCE_LEVEL_OWNERSHIP_NOT_UNIQUE');
  const add = (path: string, value: unknown): void => { outputs.set(path, typeof value === 'string' ? value : json(value)); };
  add('docs/spec/SHA256SUMS', `${spec.hashes.audit}  crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.audit.json\n${spec.hashes.prd}  crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.md\n${spec.hashes.requirements}  crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.requirements.json\n`);
  add('artifacts/spec/prd-metadata.json', { document: spec.manifest.document, sourceHashes: spec.hashes });
  const semanticPayload = { schemaVersion: '1.0.0', sourceHashes: spec.hashes, generator: 'deterministic-local-v1', normativeIds: { requirements: spec.manifest.requirements.map((item) => item.id), acceptanceCriteria: spec.manifest.acceptanceCriteria.map((item) => item.id), invariants: spec.manifest.invariants.map((item) => item.id), adrs: spec.manifest.adrs.map((item) => item.id) }, rules: { availableAt: 'Earliest time the running system could obtain a value; never backdated.', capabilityState: 'Engineering, availability, proof and influence remain independent.', outcomes: 'Signal success and execution-aware tradable success remain distinct.' } };
  add('artifacts/spec/semantic-stage.v1.json', { ...semanticPayload, artifactId: `semantic-stage-v1-${sha256(json(semanticPayload))}`, payloadSha256: sha256(json(semanticPayload)), liveModelCalls: false });
  add('artifacts/spec/requirement-index.json', spec.manifest.requirements); add('artifacts/spec/acceptance-index.json', spec.manifest.acceptanceCriteria); add('artifacts/spec/invariant-index.json', spec.manifest.invariants); add('artifacts/spec/adr-index.json', spec.manifest.adrs);
  add('artifacts/spec/package-index.json', unique(spec.manifest.requirements.map((requirement) => requirement.owner)).sort().map((owner) => ({ owner, requirements: spec.manifest.requirements.filter((requirement) => requirement.owner === owner).map((requirement) => requirement.id) })));
  add('artifacts/spec/api-index.json', api); add('artifacts/spec/persistence-index.json', persistence);
  add('artifacts/spec/capability-index.json', spec.manifest.requirements.map((requirement) => ({ requirementId: requirement.id, activationGates: requirement.activationGateRefs, initialState: 'DISABLED' })));
  add('artifacts/spec/dependency-group-index.json', spec.manifest.dependencyGroups);
  add('artifacts/spec/acceptance-partition.json', { schemaVersion: '1.0.0', assignments: acceptancePartition, counts: { task: acceptancePartition.filter((item) => item.level === 'TASK').length, cluster: acceptancePartition.filter((item) => item.level === 'CLUSTER').length, project: acceptancePartition.filter((item) => item.level === 'PROJECT').length } });
  add('artifacts/spec/specification-integrity-report.json', { status: 'PASS', deterministicValidation: true, independentReviewRequired: true, suppliedAuditTrustedAsEvidenceOnly: true, sourceHashes: spec.hashes, counts: { requirements: spec.manifest.requirements.length, acceptanceCriteria: spec.manifest.acceptanceCriteria.length, invariants: spec.manifest.invariants.length, adrs: spec.manifest.adrs.length, apiRoutes: api.length, persistenceEntities: persistence.length }, checks: ['source-hashes', 'unique-ids', 'text-hashes', 'reference-integrity', 'dependency-group-dag', 'owners', 'activation-gates', 'api-uniqueness', 'persistence-uniqueness', 'coverage'] });
  for (const [name, schema] of Object.entries(ContractSchemas)) add(`docs/schemas/${name}.schema.json`, z.toJSONSchema(schema, { target: 'draft-2020-12' }));
  for (const task of tasks) {
    add(`tasks/${task.dependencyGroup}/${task.id}.contract.json`, task);
    const requirements = spec.manifest.requirements.filter((requirement) => task.requirements.includes(requirement.id)) as HardeningRequirement[]; const acceptanceIds = unique([...task.acceptanceCriteria, ...task.taskAcceptanceFacets.map((item) => item.acceptanceId)]); const acceptance = spec.manifest.acceptanceCriteria.filter((item) => acceptanceIds.includes(item.id)) as HardeningAcceptance[]; const localAcceptance = acceptance.filter((item) => task.acceptanceCriteria.includes(item.id)); const invariants = spec.manifest.invariants.filter((item) => task.invariants.includes(item.id)); const adrs = spec.manifest.adrs.filter((item) => task.adrs.includes(item.id)); const references = classifyReferencedPaths(requirements, task, tasks, { baselinePaths }); const brief = buildImplementationBrief(task.id, requirements, references); const conformance = buildConformanceManifest({ taskId: task.id, riskLevel: task.riskLevel, requirements: task.requirements, taskAcceptanceCriteria: task.acceptanceCriteria, taskAcceptanceFacets: task.taskAcceptanceFacets, requiredTests: task.requiredTests, productionTargets: task.writeSet }); if (conformance.sha256 !== task.conformanceManifestSha256) throw new Error(`CONFORMANCE_HASH_NOT_STABLE:${task.id}`); add(task.conformanceManifestPath!, conformance.content);
    const contextFiles = new Map<string, string>([['task-contract.json', json(task)], ['requirements.json', json(requirements)], ['acceptance-criteria.json', json({ taskLocal: localAcceptance, facets: task.taskAcceptanceFacets, fullCriteriaVerifiedElsewhere: acceptance.filter((item) => !task.acceptanceCriteria.includes(item.id)) })], ['normative-excerpts.json', json(exactNormativeExcerpts(spec.prd, requirements, acceptance))], ['implementation-brief.json', json(brief)], ['interface-plan.json', json(interfacePlan(requirements, brief))], ['behavior-test-matrix.json', json(behaviorTestMatrix(task.id, localAcceptance, task.taskAcceptanceFacets))], ['referenced-path-status.json', json(references)], ['invariants.json', json(invariants)], ['adrs.json', json(adrs)], ['architecture-boundaries.json', json({ ownerPackages: task.ownerPackages, allowedPaths: task.allowedPaths, forbiddenPaths: task.forbiddenPaths, readSet: task.readSet, writeSet: task.writeSet })], ['dependency-outputs.json', json({ dependencies: task.dependencies, interfaceHashes: task.interfaceHashes })], ['public-schemas.json', json(unique(requirements.flatMap((requirement) => requirement.schemaRefs)))], ['semantic-fields.json', json({ availableAt: 'Earliest time the running system could obtain a value; never backdated.', engineeringState: 'Code existence; independent from availability or influence.', capabilityState: 'Governed availability/influence state.', signalSuccess: 'Price/profile outcome; distinct from execution-aware tradable success.', tradableSuccess: 'Mature execution-aware outcome for configured notional and delay.' })], ['pre-mortem.json', json(['Source hash drift or normative ID loss.', 'Point-in-time leakage through backdated available_at.', 'Provider failure converted into fabricated success.', 'Capability influence activated by deployed code.', 'Budget or package boundary exceeded.'])], ['source-references.json', json(unique(task.sourceReferences.map((item) => JSON.stringify(item))).map((item) => JSON.parse(item)))]]);
    const manifest = { schemaVersion: '1.0.0', taskId: task.id, sourceHashes: spec.hashes, files: [...contextFiles].map(([path, content]) => ({ path, sha256: sha256(content), bytes: Buffer.byteLength(content) })), conformanceManifestPath: task.conformanceManifestPath, conformanceManifestSha256: task.conformanceManifestSha256, generatedAt: spec.manifest.document.generatedAt };
    for (const [path, content] of contextFiles) add(`artifacts/context/${task.id}/${path}`, content); add(`artifacts/context/${task.id}/context-manifest.json`, manifest);
  }
  for (const cluster of clusters) { add(`clusters/${cluster.group}/${cluster.id}.contract.json`, cluster); add(`clusters/${cluster.group}/${cluster.id}.agent-goal.md`, goalMarkdown(cluster, 'agent-goal')); add(`clusters/${cluster.group}/${cluster.id}.codex-review.md`, goalMarkdown(cluster, 'codex-review')); add(`clusters/${cluster.group}/${cluster.id}.agent-fix-goal.md`, goalMarkdown(cluster, 'agent-fix-goal')); }
  const packageManifest = z.object({ scripts: z.record(z.string(), z.string()) }).parse(JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')));
  for (const [path, content] of outputs) if (path.endsWith('.agent-goal.md') || path.endsWith('.agent-fix-goal.md') || path.endsWith('.codex-review.md')) validateGeneratedGoalCommands(content, packageManifest.scripts);
  const taskGraph = { nodes: tasks.map((task) => ({ id: task.id, group: task.dependencyGroup, cluster: task.cluster })), edges: tasks.flatMap((task) => task.dependencies.map((dependency) => ({ from: dependency, to: task.id }))) };
  const clusterGraph = { nodes: clusters.map((cluster) => ({ id: cluster.id, group: cluster.group })), edges: clusters.flatMap((cluster) => cluster.dependencies.map((dependency) => ({ from: dependency, to: cluster.id }))) };
  const mermaid = (graph: typeof taskGraph): string => `graph TD\n${graph.nodes.map((node) => `  ${node.id.replaceAll('-', '_')}[${node.id}]`).join('\n')}\n${graph.edges.map((edge) => `  ${edge.from.replaceAll('-', '_')} --> ${edge.to.replaceAll('-', '_')}`).join('\n')}\n`;
  add('tasks/generated/graph.json', taskGraph); add('tasks/generated/graph.mmd', mermaid(taskGraph)); add('tasks/generated/cluster-graph.json', clusterGraph); add('tasks/generated/cluster-graph.mmd', mermaid(clusterGraph as typeof taskGraph)); add('tasks/generated/coverage.json', coverage);
  const implementationReady = tasks.filter((task) => task.specificationStatus === 'READY');
  const specificationGaps = tasks.filter((task) => task.specificationStatus === 'SPECIFICATION_GAP');
  add('tasks/generated/ready-queue.json', { schemaVersion: '2.0.0', generatedFrom: sha256(json(taskGraph)), ready: implementationReady.filter((task) => task.dependencies.length === 0).map((task) => task.id), blocked: tasks.filter((task) => task.specificationStatus === 'SPECIFICATION_GAP' || task.dependencies.length > 0).map((task) => ({ taskId: task.id, reason: task.specificationStatus === 'SPECIFICATION_GAP' ? 'SPECIFICATION_GAP' : 'DEPENDENCY_BLOCKED', dependencies: task.dependencies })), counts: { total: tasks.length, implementationReady: implementationReady.length, specificationGap: specificationGaps.length } });
  add('tasks/generated/path-locks.json', Object.fromEntries(tasks.map((task) => [task.id, task.exclusiveLocks]))); add('tasks/generated/interface-hashes.json', Object.fromEntries(tasks.map((task) => [task.id, task.interfaceHashes]))); add('tasks/generated/requirement-task-map.json', requirementTaskMap); add('tasks/generated/acceptance-task-map.json', acceptanceTaskMap); add('tasks/generated/acceptance-level-map.json', Object.fromEntries(acceptancePartition.map((item) => [item.acceptanceId, { level: item.level, owner: item.owner, participatingTasks: item.participatingTasks, participatingClusters: item.participatingClusters }]))); add('tasks/generated/risk-map.json', Object.fromEntries(tasks.map((task) => [task.id, { riskLevel: task.riskLevel, autonomyLevel: task.autonomyLevel, complexityBudget: task.complexityBudget, changeBudget: task.changeBudget, testQualityGate: task.testQualityGate, specificationStatus: task.specificationStatus }])));
  add('tasks/generated/architectural-baseline.json', { architecture: 'modular-monolith', runtime: 'node-22', packageOwners: unique(tasks.flatMap((task) => task.ownerPackages)).sort(), prohibitedCapabilities: ['financial-execution', 'custody', 'signing', 'transaction-submission'], sourceHashes: spec.hashes });
  return outputs;
};

const generatedRoots = ['artifacts/spec', 'artifacts/conformance', 'tasks/G0', 'tasks/G1', 'tasks/G2', 'tasks/G3', 'tasks/G4', 'tasks/G5', 'tasks/G6', 'tasks/G7', 'tasks/generated', 'clusters/G0', 'clusters/G1', 'clusters/G2', 'clusters/G3', 'clusters/G4', 'clusters/G5', 'clusters/G6', 'clusters/G7', 'docs/schemas'];
const generatedContextRoots = (outputs: OutputMap): string[] => unique([...outputs.keys()].filter((path) => path.startsWith('artifacts/context/T-G')).map((path) => path.split('/').slice(0, 3).join('/')));
const listGeneratedFiles = async (root: string): Promise<string[]> => { const files: string[] = []; for (const entry of await readdir(join(ROOT, root), { withFileTypes: true }).catch(() => [])) { const path = join(root, entry.name); if (entry.isDirectory()) files.push(...await listGeneratedFiles(path)); else files.push(path); } return files; };
export const compile = async (): Promise<{ files: number; aggregateHash: string; tasks: number; clusters: number }> => { await acquireCompilerLock(); try { const spec = await loadAndValidateSpecification(); const outputs = await buildOutputs(spec); for (const root of generatedRoots) await rm(join(ROOT, root), { recursive: true, force: true }); for (const entry of await readdir(join(ROOT, 'artifacts/context'), { withFileTypes: true }).catch(() => [])) if (entry.isDirectory() && /^T-G[0-7]-/.test(entry.name)) await rm(join(ROOT, 'artifacts/context', entry.name), { recursive: true, force: true }); for (const [path, content] of outputs) { const target = join(ROOT, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content); } const hashes = [...outputs].map(([path, content]) => `${path}:${sha256(content)}`).sort(); return { files: outputs.size, aggregateHash: sha256(hashes.join('\n')), tasks: [...outputs.keys()].filter((path) => path.endsWith('.contract.json') && path.startsWith('tasks/G')).length, clusters: [...outputs.keys()].filter((path) => path.endsWith('.contract.json') && path.startsWith('clusters/G')).length }; } finally { await rm(COMPILE_LOCK, { recursive: true, force: true }); } };
export const driftCheck = async (): Promise<{ files: number; aggregateHash: string }> => { await acquireCompilerLock(); try { const spec = await loadAndValidateSpecification(); const outputs = await buildOutputs(spec); const drift: string[] = []; for (const [path, expected] of outputs) { try { const actual = await readFile(join(ROOT, path), 'utf8'); if (actual !== expected) drift.push(path); } catch { drift.push(path); } } const actualGenerated = (await Promise.all([...generatedRoots, ...generatedContextRoots(outputs)].map(listGeneratedFiles))).flat(); for (const path of actualGenerated) if (!outputs.has(path)) drift.push(`UNEXPECTED:${path}`); if (drift.length > 0) throw new Error(`GENERATED_DRIFT:${drift.sort().join(',')}`); return { files: outputs.size, aggregateHash: sha256([...outputs].map(([path, content]) => `${path}:${sha256(content)}`).sort().join('\n')) }; } finally { await rm(COMPILE_LOCK, { recursive: true, force: true }); } };
