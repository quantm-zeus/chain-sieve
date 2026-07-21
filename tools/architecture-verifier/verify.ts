import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const roots = ['apps', 'packages'];
const walk = async (root: string): Promise<string[]> => { const result: string[] = []; for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) { const path = join(root, entry.name); if (entry.isDirectory()) result.push(...await walk(path)); else if (['.ts', '.svelte'].includes(extname(path))) result.push(path); } return result; };
const sourceFiles = async (): Promise<string[]> => (await Promise.all(roots.map((root) => walk(join(process.cwd(), root))))).flat();
const imports = (text: string): string[] => [...text.matchAll(/(?:from\s+|import\s*\()['"]([^'"]+)['"]/g)].map((match) => match[1] as string);

export const verifyArchitecture = async (): Promise<{ files: number; rules: number }> => {
  const violations: string[] = []; const files = await sourceFiles();
  for (const file of files) {
    const path = relative(process.cwd(), file); const text = await readFile(file, 'utf8'); violations.push(...architectureViolations(path, text));
  }
  if (violations.length > 0) throw new Error(`ARCHITECTURE_VIOLATIONS\n${violations.join('\n')}`); return { files: files.length, rules: 8 };
};

export const architectureViolations = (path: string, text: string): string[] => {
  const violations: string[] = []; const deps = imports(text);
  if (path.startsWith('packages/domain/') && deps.some((dependency) => /aws|postgres|drizzle|provider|hono|svelte/.test(dependency))) violations.push(`${path}:domain-infrastructure-import`);
  if (path.startsWith('packages/agent-runtime/') && deps.some((dependency) => /provider-implementations|object-store|persistence|alerts/.test(dependency))) violations.push(`${path}:agent-provider-import`);
  if (path.startsWith('packages/mcp-adapter/') && !deps.includes('@ciag/tool-core')) violations.push(`${path}:mcp-bypasses-tool-core`);
  if (path.startsWith('apps/dashboard/') && deps.some((dependency) => /provider-contracts|persistence|provider-/.test(dependency))) violations.push(`${path}:dashboard-direct-data-import`);
  if (path.includes('offline-alpha-lab') && /DATABASE_URL|production.*write/i.test(text)) violations.push(`${path}:alpha-lab-production-credentials`);
  if (path.includes('execution-simulator') && deps.some((dependency) => /sign|wallet|transaction/.test(dependency))) violations.push(`${path}:execution-signing-import`);
  if (path.includes('provider') && path.includes('adapter') && deps.some((dependency) => /svelte|dashboard|ui/.test(dependency))) violations.push(`${path}:provider-ui-import`);
  if (path.includes('discovery') && /STRICT_FREE[\s\S]{0,120}(METERED|PAID_FALLBACK)/.test(text)) violations.push(`${path}:strict-free-paid-operation`);
  if (path.startsWith('packages/agent-runtime/') && /NotificationAdapter|enqueue\(/.test(text)) violations.push(`${path}:model-direct-notification`);
  return violations;
};

export const scanPlaceholders = async (): Promise<{ files: number }> => {
  const violations: string[] = []; const files = await sourceFiles(); const patterns: [string, RegExp][] = [['placeholder', /\b(?:TODO|FIXME|HACK|TEMP|NOT_IMPLEMENTED)\b/], ['empty-catch', /catch\s*\{\s*\}/], ['suppression', /@ts-ignore|eslint-disable/], ['hard-coded-pass', /status\s*:\s*['"]PASS['"]/], ['skipped-test', /\.(?:skip|todo)\s*\(/], ['trivial-assertion', /expect\s*\(\s*(?:true|1)\s*\)\.toBe\s*\(\s*(?:true|1)\s*\)/]];
  for (const file of files) { const path = relative(process.cwd(), file); const text = await readFile(file, 'utf8'); for (const [name, pattern] of patterns) if (pattern.test(text)) violations.push(`${path}:${name}`); }
  if (violations.length > 0) throw new Error(`PLACEHOLDER_VIOLATIONS\n${violations.join('\n')}`); return { files: files.length };
};

export const scanProhibitedCapabilities = async (): Promise<{ files: number }> => {
  const violations: string[] = []; const files = (await sourceFiles()).filter((file) => !relative(process.cwd(), file).startsWith('packages/security/') && !relative(process.cwd(), file).startsWith('packages/provider-contracts/'));
  const patterns = [/\bprivateKey\b/, /\bseedPhrase\b/, /\bmnemonic\b/, /\bsignTransaction\b/, /\bsendTransaction\b/, /\bexecuteSwap\b/, /\bapproveToken\b/, /\bplaceOrder\b/];
  for (const file of files) { const text = await readFile(file, 'utf8'); for (const pattern of patterns) if (pattern.test(text)) violations.push(`${relative(process.cwd(), file)}:${pattern.source}`); }
  if (violations.length > 0) throw new Error(`PROHIBITED_CAPABILITY_VIOLATIONS\n${violations.join('\n')}`); return { files: files.length };
};
