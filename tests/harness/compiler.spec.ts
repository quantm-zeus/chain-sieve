import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { compile, driftCheck, loadAndValidateSpecification, sha256, validateGeneratedGoalCommands } from '../../tools/prd-compiler/compiler.js';
import { deriveEvidenceVerdict, loadTasks, verifyCoverage } from '../../tools/task-verifier/verify.js';

const temporary: string[] = [];
const generatedRoots = ['artifacts/spec', 'artifacts/context', 'artifacts/conformance', 'tasks', 'clusters', 'docs/schemas'];
const generatedTreeHash = async (): Promise<string> => {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.push(path);
    }
  };
  for (const root of generatedRoots) await walk(root);
  const hash = createHash('sha256');
  for (const path of files.sort()) hash.update(`${relative(process.cwd(), path)}\0`).update(await readFile(path));
  return hash.digest('hex');
};
let repositoryGeneratedHash = '';
beforeAll(async () => { repositoryGeneratedHash = await generatedTreeHash(); });
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))));
afterAll(async () => { expect(await generatedTreeHash()).toBe(repositoryGeneratedHash); });

describe('deterministic PRD compiler', () => {
  it('independently validates authoritative sources', async () => { const specification = await loadAndValidateSpecification(); expect(specification.manifest.requirements).toHaveLength(397); expect(specification.manifest.acceptanceCriteria).toHaveLength(204); expect(specification.issues).toEqual([]); });
  it('reproduces identical aggregate hashes in an isolated output root', async () => { const outputRoot = await mkdtemp(join(tmpdir(), 'ciag-compiler-output-')); temporary.push(outputRoot); const options = { sourceRoot: process.cwd(), outputRoot }; const first = await compile(options); const second = await compile(options); expect(second.aggregateHash).toBe(first.aggregateHash); expect(second.tasks).toBeGreaterThan(60); expect(second.clusters).toBe(8); await expect(driftCheck(options)).resolves.toMatchObject({ aggregateHash: first.aggregateHash }); expect(await generatedTreeHash()).toBe(repositoryGeneratedHash); });
  it('maps every requirement and acceptance criterion', async () => { await expect(verifyCoverage()).resolves.toMatchObject({ requirements: 397, acceptanceCriteria: 204 }); });
  it('rejects completion forgery rather than trusting PASS', () => { expect(() => deriveEvidenceVerdict(['pnpm test'], [{ command: 'pnpm test', exitCode: 0, output: 'PASS', outputSha256: sha256('PASS') }])).toThrow('UNSUBSTANTIATED_COMMAND_EVIDENCE'); expect(() => deriveEvidenceVerdict(['pnpm test'], [{ command: 'pnpm test', exitCode: 0, output: '12 tests passed in 1.3s', outputSha256: 'forged' }])).toThrow('FORGED_COMMAND_EVIDENCE'); });
  it('rejects nonexistent commands, root-only verifier actions and invalid lifecycle transitions in generated goals', () => { const scripts = { 'task:acquire': 'x', 'task:begin': 'x', 'task:self-review': 'x', 'task:verify': 'x', 'merge-queue:add': 'x', 'merge-queue:process': 'x', 'cluster:verify': 'x', 'cluster:report': 'x' }; const valid = '`pnpm task:acquire <task-id> --holder zcode` `pnpm task:begin <task-id> --holder zcode --lease-version <version>` `pnpm task:self-review <task-id> --holder zcode --lease-version <version>` `pnpm cluster:verify C-G0-IMPLEMENTATION` `pnpm cluster:report C-G0-IMPLEMENTATION`'; expect(validateGeneratedGoalCommands(valid, scripts)).toHaveLength(5); expect(() => validateGeneratedGoalCommands(`${valid} ` + '`pnpm task:nonexistent <task-id>`', scripts)).toThrow('UNKNOWN_GENERATED_COMMAND:task:nonexistent'); expect(() => validateGeneratedGoalCommands(`${valid} ` + '`pnpm task:verify <task-id> --holder zcode --lease-version <version>`', scripts)).toThrow('IMPLEMENTATION_GOAL_ROOT_ACTION_PROHIBITED:task:verify'); expect(() => validateGeneratedGoalCommands(valid.replace('task:begin', 'task:missing'), { ...scripts, 'task:missing': 'x' })).toThrow('INVALID_GENERATED_GOAL_STATE_TRANSITIONS'); });
  it('freezes semantic IDs in a content-addressed artifact without live model calls', async () => { const specification = await loadAndValidateSpecification(); const semantic = JSON.parse(await readFile('artifacts/spec/semantic-stage.v1.json', 'utf8')) as { artifactId: string; payloadSha256: string; liveModelCalls: boolean; normativeIds: { requirements: string[]; acceptanceCriteria: string[] } }; expect(semantic.artifactId).toBe(`semantic-stage-v1-${semantic.payloadSha256}`); expect(semantic.liveModelCalls).toBe(false); expect(semantic.normativeIds.requirements).toEqual(specification.manifest.requirements.map((item) => item.id)); expect(semantic.normativeIds.acceptanceCriteria).toEqual(specification.manifest.acceptanceCriteria.map((item) => item.id)); });
  it('generates bounded scopes with unique acceptance ownership and exclusive migration authority', async () => { const tasks = await loadTasks(); expect(Math.max(...tasks.map((task) => task.requirements.length))).toBeLessThanOrEqual(8); const acceptance = tasks.flatMap((task) => task.acceptanceCriteria); expect(new Set(acceptance).size).toBe(acceptance.length); for (const task of tasks) { expect(task.writeSet.every((path) => task.allowedPaths.includes(path))).toBe(true); if (!task.ownerPackages.includes('packages/persistence')) { expect(task.allowedPaths).not.toContain('infra/migrations/**'); expect(task.forbiddenPaths).toContain('infra/migrations/**'); } } });
  it('rejects unexpected generated files only inside an isolated output root', async () => { const outputRoot = await mkdtemp(join(tmpdir(), 'ciag-compiler-drift-')); temporary.push(outputRoot); const options = { sourceRoot: process.cwd(), outputRoot }; await compile(options); const path = join(outputRoot, 'artifacts/spec/__unexpected-audit-mutation.json'); await writeFile(path, '{}\n'); await expect(driftCheck(options)).rejects.toThrow('UNEXPECTED:artifacts/spec/__unexpected-audit-mutation.json'); expect(await generatedTreeHash()).toBe(repositoryGeneratedHash); });
});
