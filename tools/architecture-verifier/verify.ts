import { readFile, readdir } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';

const architectureRoots = ['apps', 'packages'];
const executableRoots = ['apps', 'packages', 'tools', 'tests', 'infra', '.github'];
const executableExtensions = new Set(['.ts', '.js', '.mjs', '.cjs', '.svelte', '.sql', '.yml', '.yaml']);
const walk = async (root: string): Promise<string[]> => { const result: string[] = []; for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) { const path = join(root, entry.name); if (entry.isDirectory()) result.push(...await walk(path)); else if (['.ts', '.svelte'].includes(extname(path))) result.push(path); } return result; };
const ignoredDirectories = new Set(['node_modules', '.svelte-kit', 'build', 'dist', 'coverage', 'test-results', 'playwright-report']);
const walkExecutable = async (root: string): Promise<string[]> => { const result: string[] = []; for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) { const path = join(root, entry.name); if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) result.push(...await walkExecutable(path)); else if (!entry.isDirectory() && (executableExtensions.has(extname(path)) || basename(path).startsWith('Dockerfile'))) result.push(path); } return result; };
const sourceFiles = async (cwd: string): Promise<string[]> => (await Promise.all(architectureRoots.map((root) => walk(join(cwd, root))))).flat();
const executableFiles = async (cwd: string): Promise<string[]> => (await Promise.all(executableRoots.map((root) => walkExecutable(join(cwd, root))))).flat();
const imports = (text: string): string[] => [...text.matchAll(/(?:from\s+|import\s*\()['"]([^'"]+)['"]/g)].map((match) => match[1] as string);

export const verifyArchitecture = async (cwd = process.cwd()): Promise<{ files: number; rules: number }> => {
  const violations: string[] = []; const files = await sourceFiles(cwd);
  const packageEdges = new Map<string, Set<string>>();
  for (const file of files) {
    const path = relative(cwd, file); const text = await readFile(file, 'utf8'); violations.push(...architectureViolations(path, text));
    const owner = /^(?:apps|packages)\/[^/]+/.exec(path)?.[0]; if (owner) { const edges = packageEdges.get(owner) ?? new Set<string>(); for (const dependency of imports(text)) { const match = /^@ciag\/([^/]+)/.exec(dependency); if (match?.[1]) edges.add(`packages/${match[1]}`); } packageEdges.set(owner, edges); }
  }
  const visit = (node: string, path: string[]): void => { if (path.includes(node)) { violations.push(`package-cycle:${[...path.slice(path.indexOf(node)), node].join('>')}`); return; } for (const dependency of packageEdges.get(node) ?? []) if (packageEdges.has(dependency)) visit(dependency, [...path, node]); };
  for (const node of packageEdges.keys()) visit(node, []);
  if (violations.length > 0) throw new Error(`ARCHITECTURE_VIOLATIONS\n${[...new Set(violations)].join('\n')}`); return { files: files.length, rules: 11 };
};

export const architectureViolations = (path: string, text: string): string[] => {
  const violations: string[] = []; const deps = imports(text);
  if (path.startsWith('packages/domain/') && deps.some((dependency) => /aws|postgres|drizzle|provider|hono|svelte/.test(dependency))) violations.push(`${path}:domain-infrastructure-import`);
  if (path.startsWith('packages/agent-runtime/') && deps.some((dependency) => /provider-implementations|object-store|persistence|alerts/.test(dependency))) violations.push(`${path}:agent-provider-import`);
  if (path.startsWith('packages/mcp-adapter/') && !deps.includes('@ciag/tool-core')) violations.push(`${path}:mcp-bypasses-tool-core`);
  if (path.startsWith('apps/api/') && /McpServer|registerTool\(/.test(text) && !deps.includes('@ciag/mcp-adapter')) violations.push(`${path}:api-mcp-bypasses-adapter`);
  if (!path.startsWith('packages/persistence/') && !path.startsWith('packages/test-fixtures/') && deps.some((dependency) => dependency === 'postgres' || dependency.startsWith('drizzle-orm'))) violations.push(`${path}:persistence-authority-bypass`);
  if (path.startsWith('apps/dashboard/') && deps.some((dependency) => /provider-contracts|persistence|provider-/.test(dependency))) violations.push(`${path}:dashboard-direct-data-import`);
  if (path.includes('offline-alpha-lab') && /DATABASE_URL|production.*write/i.test(text)) violations.push(`${path}:alpha-lab-production-credentials`);
  if (path.includes('execution-simulator') && deps.some((dependency) => /sign|wallet|transaction/.test(dependency))) violations.push(`${path}:execution-signing-import`);
  if (path.includes('provider') && path.includes('adapter') && deps.some((dependency) => /svelte|dashboard|ui/.test(dependency))) violations.push(`${path}:provider-ui-import`);
  if (path.includes('discovery') && /STRICT_FREE[\s\S]{0,120}(METERED|PAID_FALLBACK)/.test(text)) violations.push(`${path}:strict-free-paid-operation`);
  if (path.startsWith('packages/agent-runtime/') && /NotificationAdapter|enqueue\(/.test(text)) violations.push(`${path}:model-direct-notification`);
  return violations;
};

export const scanPlaceholders = async (cwd = process.cwd()): Promise<{ files: number }> => {
  const violations: string[] = []; const files = (await executableFiles(cwd)).filter((file) => relative(cwd, file) !== 'tools/architecture-verifier/verify.ts');
  for (const file of files) { const path = relative(cwd, file); const text = await readFile(file, 'utf8'); violations.push(...placeholderViolations(path, text)); }
  if (violations.length > 0) throw new Error(`PLACEHOLDER_VIOLATIONS\n${violations.join('\n')}`); return { files: files.length };
};

export const placeholderViolations = (path: string, text: string): string[] => { const patterns: [string, RegExp][] = [['placeholder', /\b(?:TODO|FIXME|HACK|TEMP|NOT_IMPLEMENTED)\b/], ['empty-catch', /catch\s*\{\s*\}/], ['suppression', /@ts-ignore|eslint-disable/], ['skipped-test', /\.(?:skip|todo)\s*\(|\b(?:describe|it|test)\.(?:skip|todo)\b/], ['trivial-assertion', /expect\s*\(\s*(?:true|1)\s*\)\.toBe\s*\(\s*(?:true|1)\s*\)/]]; return patterns.filter(([, pattern]) => pattern.test(text)).map(([name]) => `${path}:${name}`); };

export const scanProhibitedCapabilities = async (cwd = process.cwd()): Promise<{ files: number }> => {
  const violations: string[] = []; const files = (await executableFiles(cwd)).filter((file) => { const path = relative(cwd, file); return path !== 'tools/architecture-verifier/verify.ts' && !path.startsWith('packages/security/') && !path.startsWith('packages/provider-contracts/') && !path.startsWith('tests/'); });
  for (const file of files) { const path = relative(cwd, file); const text = await readFile(file, 'utf8'); violations.push(...prohibitedCapabilityViolations(path, text)); }
  if (violations.length > 0) throw new Error(`PROHIBITED_CAPABILITY_VIOLATIONS\n${violations.join('\n')}`); return { files: files.length };
};

export const prohibitedCapabilityViolations = (path: string, text: string): string[] => { const patterns = [/\bprivateKey\b/i, /\bseedPhrase\b/i, /\bmnemonic\b/i, /\bsign(?:ed)?(?:Transaction|Payload)\b/i, /\b(?:send|submit|broadcast)(?:Raw)?(?:Transaction|SignedPayload)\b/i, /\bexecuteSwap\b/i, /\bapproveToken\b/i, /\bplaceOrder\b/i, /\bwalletCustody\b/i]; return patterns.filter((pattern) => pattern.test(text)).map((pattern) => `${path}:${pattern.source}`); };
