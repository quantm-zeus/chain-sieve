import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { ClusterContractSchema, ContractSchemas, TaskContractSchema, type ClusterContract, type TaskContract } from '@ciag/shared-schemas';

const ROOT = resolve(process.cwd());
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

const makeTasks = (spec: ValidatedSpecification): TaskContract[] => {
  const byKey = new Map<string, Manifest['requirements']>();
  for (const requirement of spec.manifest.requirements) { const key = `${requirement.dependencyGroup}|${requirement.family}|${requirement.owner}`; byKey.set(key, [...(byKey.get(key) ?? []), requirement]); }
  const taskIdByKey = new Map([...byKey.keys()].map((key) => { const [group, family] = key.split('|') as [string, string]; return [key, `T-${group}-${safeId(family)}`]; }));
  const byGroup = new Map<string, string[]>();
  for (const [key, id] of taskIdByKey) { const group = key.split('|')[0] as string; byGroup.set(group, [...(byGroup.get(group) ?? []), id]); }
  return [...byKey.entries()].map(([key, requirements]) => {
    const [group, family, owner] = key.split('|') as [string, string, string]; const id = taskIdByKey.get(key) as string;
    const groupDefinition = spec.manifest.dependencyGroups.find((value) => value.id === group); const acceptance = spec.manifest.acceptanceCriteria.filter((item) => item.requirementRefs.some((ref) => requirements.some((requirement) => requirement.id === ref)));
    const invariantRefs = unique(requirements.flatMap((requirement) => requirement.securityRightsCostControls.filter((ref) => ref.startsWith('INV-'))));
    const riskLevel = /SEC|EXEC|PROD|LEGAL|ALAB|ADG/.test(family) ? 'CRITICAL' as const : requirements.length > 8 ? 'HIGH' as const : 'MEDIUM' as const;
    return TaskContractSchema.parse({
      schemaVersion: '1.0.0', id, title: `${family} implementation contract`, sourceHashes: spec.hashes, dependencyGroup: group, cluster: `C-${group}-IMPLEMENTATION`, riskLevel, autonomyLevel: riskLevel === 'CRITICAL' ? 'OWNER_APPROVAL_REQUIRED' : riskLevel === 'HIGH' ? 'REVIEW_REQUIRED' : 'AUTONOMOUS', dependencies: unique((groupDefinition?.dependsOn ?? []).flatMap((dependency) => byGroup.get(dependency) ?? [])).sort(), requirements: requirements.map((requirement) => requirement.id), acceptanceCriteria: acceptance.map((item) => item.id), invariants: invariantRefs.length > 0 ? invariantRefs : ['INV-001', 'INV-044'], adrs: ['ADR-001'], ownerPackages: [owner], readSet: ['docs/spec/**', 'artifacts/context/' + id + '/**', ...unique(requirements.flatMap((requirement) => requirement.schemaRefs))], writeSet: unique(requirements.flatMap((requirement) => requirement.implementationRefs.map((ref) => ref.split(' ')[0] as string))), allowedPaths: unique([`${owner}/**`, 'tests/**', 'docs/implementation/**', 'infra/migrations/**']), forbiddenPaths: ['docs/spec/**', 'artifacts/spec/**', 'tasks/generated/**', '.github/workflows/**'], exclusiveLocks: owner.includes('persistence') ? ['infra/migrations'] : [`${owner}/public-api`], interfaceHashes: { [`${owner}:contract`]: sha256(requirements.map((requirement) => `${requirement.id}:${requirement.textSha256}`).join('\n')) }, deliverables: unique(requirements.flatMap((requirement) => requirement.implementationRefs)).slice(0, 30).concat([`${owner} implementation and tests`]), constraints: ['Preserve every referenced normative ID and degraded behavior.', 'Keep product influence disabled until explicit activation gates pass.', 'Use point-in-time and evidence semantics where externally sourced data is involved.'], nonGoals: ['No financial execution, signing, custody, or transaction submission.', 'No automatic alpha or product capability activation.', 'No unrelated dependency-group implementation.'], degradedBehavior: 'Fail closed or return NOT_AVAILABLE/INSUFFICIENT_DATA with provenance; never fabricate success.', rollback: 'Revert the single atomic task commit and restore the prior schema/config artifact; migrations require a forward compensating migration.', requiredTests: unique(acceptance.flatMap((item) => [item.positiveTestRef, item.negativeOrFailureTestRef])), verificationCommands: [{ command: `pnpm task:verify ${id}`, expected: 'exit 0 with independently derived evidence' }, { command: 'pnpm architecture:verify', expected: 'all architecture fitness controls pass' }], complexityBudget: { maxFiles: 24, maxChangedLines: 1800, maxCyclomaticComplexity: 12 }, changeBudget: { maxMigrations: owner.includes('persistence') ? 3 : 0, maxPublicInterfaces: 4, requiresSplitAboveBudget: true }, stopConditions: ['A source hash differs from the task contract.', 'A dependency is not MERGED or its public interface hash changed.', 'Required behavior exceeds a declared budget without an approved split.', 'A prohibited capability or activation path would be introduced.'], completionDefinition: ['All mapped positive and negative tests pass.', 'Deterministic verifier derives PASS from repository evidence.', 'One atomic task commit exists and architecture checks pass.', 'Degraded, replay, rollback, and observability behavior is documented and tested.'], sourceReferences: requirements.map((requirement) => ({ path: 'docs/spec/crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.md', line: requirement.line, id: requirement.id })),
    });
  }).sort((a, b) => a.id.localeCompare(b.id));
};

const makeClusters = (spec: ValidatedSpecification, tasks: TaskContract[]): ClusterContract[] => spec.manifest.dependencyGroups.map((group) => {
  const grouped = tasks.filter((task) => task.dependencyGroup === group.id); return ClusterContractSchema.parse({ schemaVersion: '1.0.0', id: `C-${group.id}-IMPLEMENTATION`, group: group.id, title: group.name, sourceHashes: spec.hashes, dependencies: group.dependsOn.map((id) => `C-${id}-IMPLEMENTATION`), tasks: grouped.map((task) => task.id), requirements: unique(grouped.flatMap((task) => task.requirements)), acceptanceCriteria: unique(grouped.flatMap((task) => task.acceptanceCriteria)), invariants: unique(grouped.flatMap((task) => task.invariants)), entryCriteria: ['All dependency clusters have independent PASS reviews.', 'Source hashes match and task ready queue is current.'], exitCriteria: ['Every task is independently verified and atomically committed.', 'Cluster integration, architecture, security, migration, and replay checks pass.', 'Codex independent cluster review records PASS.'], verificationCommands: [{ command: `pnpm cluster:verify C-${group.id}-IMPLEMENTATION`, expected: 'exit 0' }, { command: 'pnpm harness:verify', expected: 'exit 0' }], rollback: 'Revert cluster task commits in reverse dependency order; capability state remains disabled or shadow.' });
});

const goalMarkdown = (cluster: ClusterContract, mode: 'zcode-goal' | 'codex-review' | 'zcode-fix-goal'): string => {
  const action = mode === 'zcode-goal' ? 'Implement each READY task one at a time' : mode === 'codex-review' ? 'Independently review the completed cluster and produce PASS or CHANGES_REQUIRED' : 'Fix only the findings in the latest cluster review';
  return `# ${cluster.id} ${mode}\n\n${action}. The immutable contract is \`${cluster.id}.contract.json\`. Validate source hashes before work.\n\nTasks, in contract order:\n${cluster.tasks.map((task) => `- \`${task}\``).join('\n')}\n\nFor every task: acquire its monotonically-versioned lease, honor read/write sets and exclusive locks, implement only its IDs, run \`pnpm task:verify <task-id>\`, self-review the diff, and create one atomic commit. Stop on hash drift, stale lease, path conflict, budget breach, prohibited capability, or unmet dependency. Never activate product or alpha capability.\n\nCluster completion requires \`pnpm cluster:verify ${cluster.id}\` and an independent Codex review.\n`;
};

const buildOutputs = async (spec: ValidatedSpecification): Promise<OutputMap> => {
  const outputs: OutputMap = new Map(); const tasks = makeTasks(spec); const clusters = makeClusters(spec, tasks); const api = extractApi(spec.prd); const persistence = extractPersistence(spec.prd);
  const requirementTaskMap = Object.fromEntries(spec.manifest.requirements.map((requirement) => [requirement.id, tasks.filter((task) => task.requirements.includes(requirement.id)).map((task) => task.id)]));
  const acceptanceTaskMap = Object.fromEntries(spec.manifest.acceptanceCriteria.map((acceptance) => [acceptance.id, tasks.filter((task) => task.acceptanceCriteria.includes(acceptance.id)).map((task) => task.id)]));
  const coverage = { requirements: { total: spec.manifest.requirements.length, mapped: Object.values(requirementTaskMap).filter((ids) => ids.length > 0).length }, acceptanceCriteria: { total: spec.manifest.acceptanceCriteria.length, mapped: Object.values(acceptanceTaskMap).filter((ids) => ids.length > 0).length } };
  if (coverage.requirements.total !== coverage.requirements.mapped || coverage.acceptanceCriteria.total !== coverage.acceptanceCriteria.mapped) throw new Error('INCOMPLETE_COVERAGE');
  const add = (path: string, value: unknown): void => { outputs.set(path, typeof value === 'string' ? value : json(value)); };
  add('docs/spec/SHA256SUMS', `${spec.hashes.audit}  crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.audit.json\n${spec.hashes.prd}  crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.md\n${spec.hashes.requirements}  crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.requirements.json\n`);
  add('artifacts/spec/prd-metadata.json', { document: spec.manifest.document, sourceHashes: spec.hashes });
  add('artifacts/spec/requirement-index.json', spec.manifest.requirements); add('artifacts/spec/acceptance-index.json', spec.manifest.acceptanceCriteria); add('artifacts/spec/invariant-index.json', spec.manifest.invariants); add('artifacts/spec/adr-index.json', spec.manifest.adrs);
  add('artifacts/spec/package-index.json', unique(spec.manifest.requirements.map((requirement) => requirement.owner)).sort().map((owner) => ({ owner, requirements: spec.manifest.requirements.filter((requirement) => requirement.owner === owner).map((requirement) => requirement.id) })));
  add('artifacts/spec/api-index.json', api); add('artifacts/spec/persistence-index.json', persistence);
  add('artifacts/spec/capability-index.json', spec.manifest.requirements.map((requirement) => ({ requirementId: requirement.id, activationGates: requirement.activationGateRefs, initialState: 'DISABLED' })));
  add('artifacts/spec/dependency-group-index.json', spec.manifest.dependencyGroups);
  add('artifacts/spec/specification-integrity-report.json', { status: 'PASS', independentlyValidated: true, suppliedAuditTrustedAsEvidenceOnly: true, sourceHashes: spec.hashes, counts: { requirements: spec.manifest.requirements.length, acceptanceCriteria: spec.manifest.acceptanceCriteria.length, invariants: spec.manifest.invariants.length, adrs: spec.manifest.adrs.length, apiRoutes: api.length, persistenceEntities: persistence.length }, checks: ['source-hashes', 'unique-ids', 'text-hashes', 'reference-integrity', 'dependency-group-dag', 'owners', 'activation-gates', 'api-uniqueness', 'persistence-uniqueness', 'placeholder-scan', 'coverage'] });
  for (const [name, schema] of Object.entries(ContractSchemas)) add(`docs/schemas/${name}.schema.json`, z.toJSONSchema(schema, { target: 'draft-2020-12' }));
  for (const task of tasks) {
    add(`tasks/${task.dependencyGroup}/${task.id}.contract.json`, task);
    const requirements = spec.manifest.requirements.filter((requirement) => task.requirements.includes(requirement.id)); const acceptance = spec.manifest.acceptanceCriteria.filter((item) => task.acceptanceCriteria.includes(item.id)); const invariants = spec.manifest.invariants.filter((item) => task.invariants.includes(item.id)); const adrs = spec.manifest.adrs.filter((item) => task.adrs.includes(item.id));
    const contextFiles = new Map<string, string>([['task-contract.json', json(task)], ['requirements.json', json(requirements)], ['acceptance-criteria.json', json(acceptance)], ['invariants.json', json(invariants)], ['adrs.json', json(adrs)], ['architecture-boundaries.json', json({ ownerPackages: task.ownerPackages, allowedPaths: task.allowedPaths, forbiddenPaths: task.forbiddenPaths, readSet: task.readSet, writeSet: task.writeSet })], ['dependency-outputs.json', json({ dependencies: task.dependencies, interfaceHashes: task.interfaceHashes })], ['public-schemas.json', json(requirements.flatMap((requirement) => requirement.schemaRefs))], ['semantic-fields.json', json({ availableAt: 'Earliest time the running system could obtain a value; never backdated.', engineeringState: 'Code existence; independent from availability or influence.', capabilityState: 'Governed availability/influence state.', signalSuccess: 'Price/profile outcome; distinct from execution-aware tradable success.', tradableSuccess: 'Mature execution-aware outcome for configured notional and delay.' })], ['pre-mortem.json', json(['Source hash drift or normative ID loss.', 'Point-in-time leakage through backdated available_at.', 'Provider failure converted into fabricated success.', 'Capability influence activated by deployed code.', 'Budget or package boundary exceeded.'])], ['source-references.json', json(task.sourceReferences)]]);
    const manifest = { schemaVersion: '1.0.0', taskId: task.id, sourceHashes: spec.hashes, files: [...contextFiles].map(([path, content]) => ({ path, sha256: sha256(content), bytes: Buffer.byteLength(content) })), generatedAt: spec.manifest.document.generatedAt };
    for (const [path, content] of contextFiles) add(`artifacts/context/${task.id}/${path}`, content); add(`artifacts/context/${task.id}/context-manifest.json`, manifest);
  }
  for (const cluster of clusters) { add(`clusters/${cluster.group}/${cluster.id}.contract.json`, cluster); add(`clusters/${cluster.group}/${cluster.id}.zcode-goal.md`, goalMarkdown(cluster, 'zcode-goal')); add(`clusters/${cluster.group}/${cluster.id}.codex-review.md`, goalMarkdown(cluster, 'codex-review')); add(`clusters/${cluster.group}/${cluster.id}.zcode-fix-goal.md`, goalMarkdown(cluster, 'zcode-fix-goal')); }
  const taskGraph = { nodes: tasks.map((task) => ({ id: task.id, group: task.dependencyGroup, cluster: task.cluster })), edges: tasks.flatMap((task) => task.dependencies.map((dependency) => ({ from: dependency, to: task.id }))) };
  const clusterGraph = { nodes: clusters.map((cluster) => ({ id: cluster.id, group: cluster.group })), edges: clusters.flatMap((cluster) => cluster.dependencies.map((dependency) => ({ from: dependency, to: cluster.id }))) };
  const mermaid = (graph: typeof taskGraph): string => `graph TD\n${graph.nodes.map((node) => `  ${node.id.replaceAll('-', '_')}[${node.id}]`).join('\n')}\n${graph.edges.map((edge) => `  ${edge.from.replaceAll('-', '_')} --> ${edge.to.replaceAll('-', '_')}`).join('\n')}\n`;
  add('tasks/generated/graph.json', taskGraph); add('tasks/generated/graph.mmd', mermaid(taskGraph)); add('tasks/generated/cluster-graph.json', clusterGraph); add('tasks/generated/cluster-graph.mmd', mermaid(clusterGraph as typeof taskGraph)); add('tasks/generated/coverage.json', coverage);
  add('tasks/generated/ready-queue.json', { schemaVersion: '1.0.0', generatedFrom: sha256(json(taskGraph)), ready: tasks.filter((task) => task.dependencies.length === 0).map((task) => task.id), blocked: tasks.filter((task) => task.dependencies.length > 0).map((task) => ({ taskId: task.id, dependencies: task.dependencies })) });
  add('tasks/generated/path-locks.json', Object.fromEntries(tasks.map((task) => [task.id, task.exclusiveLocks]))); add('tasks/generated/interface-hashes.json', Object.fromEntries(tasks.map((task) => [task.id, task.interfaceHashes]))); add('tasks/generated/requirement-task-map.json', requirementTaskMap); add('tasks/generated/acceptance-task-map.json', acceptanceTaskMap); add('tasks/generated/risk-map.json', Object.fromEntries(tasks.map((task) => [task.id, { riskLevel: task.riskLevel, autonomyLevel: task.autonomyLevel, complexityBudget: task.complexityBudget, changeBudget: task.changeBudget }])));
  add('tasks/generated/architectural-baseline.json', { architecture: 'modular-monolith', runtime: 'node-24', packageOwners: unique(tasks.flatMap((task) => task.ownerPackages)).sort(), prohibitedCapabilities: ['financial-execution', 'custody', 'signing', 'transaction-submission'], sourceHashes: spec.hashes });
  return outputs;
};

const generatedRoots = ['artifacts/spec', 'artifacts/context', 'tasks/G0', 'tasks/G1', 'tasks/G2', 'tasks/G3', 'tasks/G4', 'tasks/G5', 'tasks/G6', 'tasks/G7', 'tasks/generated', 'clusters/G0', 'clusters/G1', 'clusters/G2', 'clusters/G3', 'clusters/G4', 'clusters/G5', 'clusters/G6', 'clusters/G7', 'docs/schemas'];
export const compile = async (): Promise<{ files: number; aggregateHash: string; tasks: number; clusters: number }> => { const spec = await loadAndValidateSpecification(); const outputs = await buildOutputs(spec); for (const root of generatedRoots) await rm(join(ROOT, root), { recursive: true, force: true }); for (const [path, content] of outputs) { const target = join(ROOT, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content); } const hashes = [...outputs].map(([path, content]) => `${path}:${sha256(content)}`).sort(); return { files: outputs.size, aggregateHash: sha256(hashes.join('\n')), tasks: [...outputs.keys()].filter((path) => path.endsWith('.contract.json') && path.startsWith('tasks/G')).length, clusters: [...outputs.keys()].filter((path) => path.endsWith('.contract.json') && path.startsWith('clusters/G')).length } };
export const driftCheck = async (): Promise<{ files: number; aggregateHash: string }> => { const spec = await loadAndValidateSpecification(); const outputs = await buildOutputs(spec); const drift: string[] = []; for (const [path, expected] of outputs) { try { const actual = await readFile(join(ROOT, path), 'utf8'); if (actual !== expected) drift.push(path); } catch { drift.push(path); } } if (drift.length > 0) throw new Error(`GENERATED_DRIFT:${drift.join(',')}`); return { files: outputs.size, aggregateHash: sha256([...outputs].map(([path, content]) => `${path}:${sha256(content)}`).sort().join('\n')) }; };
