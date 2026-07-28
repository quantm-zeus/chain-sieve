import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const excluded = [
  /^docs\/spec\//, /^artifacts\/spec\//, /^artifacts\/context\//, /^artifacts\/release-attestation\//,
  /^artifacts\/(?:final|reviews)\//, /^tasks\/G[0-7]\//, /^tasks\/generated\//, /^clusters\/G[0-7]\//,
  /^docs\/schemas\//, /^docs\/prompts\/.*\.md$/, /^tasks\/repairs\/.*\.(?:yaml|sha256)$/, /^pnpm-lock\.yaml$/,
];
const owned = [
  /^(?:apps|packages|tools|tests)\//, /^\.github\//, /^docs\/.*\.md$/, /^(?:AGENTS|ARCHITECTURE|CONTRIBUTING|INVARIANTS|SECURITY)\.md$/,
  /^(?:package|tsconfig|eslint\.config|svelte\.config|vite\.config|vitest[^/]*)\.(?:json|js|ts)$/,
  /^(?:pnpm-workspace|docker-compose(?:\.production)?)\.ya?ml$/, /^\.prettier(?:ignore|rc\.json)$/, /^\.dockerignore$/,
  /(?:^|\/)Dockerfile$/,
];

export const isOwnedFormattingPath = (path: string): boolean => !excluded.some((pattern) => pattern.test(path)) && owned.some((pattern) => pattern.test(path));
export const normalizeOwnedText = (text: string): string => `${text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/[ \t]+$/g, '')).join('\n').replace(/\n*$/, '')}\n`;
export const formatViolations = (path: string, text: string): string[] => {
  const violations: string[] = [];
  if (/\r/.test(text)) violations.push('CRLF_OR_CR');
  if (text.split('\n').some((line) => /[ \t]+\r?$/.test(line))) violations.push('TRAILING_WHITESPACE');
  if (text.length > 0 && !text.endsWith('\n')) violations.push('MISSING_FINAL_NEWLINE');
  if (/^(?:<<<<<<<|=======|>>>>>>>)(?: |$)/m.test(text)) violations.push('CONFLICT_MARKER');
  if (path.endsWith('.json')) { try { JSON.parse(text); } catch { violations.push('INVALID_JSON'); } }
  return violations;
};

export const verifyOwnedFormatting = async (mode: 'check' | 'write'): Promise<{ checked: number; rewritten: number }> => {
  const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`FORMAT_FILE_INVENTORY_FAILED:${result.stderr.trim()}`);
  const paths = result.stdout.split('\0').filter(Boolean).filter(isOwnedFormattingPath).sort(); let rewritten = 0; const failures: string[] = [];
  for (const path of paths) {
    const text = await readFile(path, 'utf8'); const normalized = normalizeOwnedText(text);
    if (mode === 'write' && text !== normalized) { await writeFile(path, normalized); rewritten += 1; }
    const violations = formatViolations(path, mode === 'write' ? normalized : text);
    if (violations.length > 0) failures.push(`${path}:${violations.join(',')}`);
  }
  if (failures.length > 0) throw new Error(`OWNED_FORMATTING_VIOLATIONS:${failures.join(';')}`);
  return { checked: paths.length, rewritten };
};

if (process.argv[1]?.endsWith('/format.ts')) {
  const mode = process.argv[2] === 'write' ? 'write' : 'check';
  try { console.log(JSON.stringify({ status: 'PASS', mode, ...(await verifyOwnedFormatting(mode)) })); }
  catch (error) { console.error(JSON.stringify({ status: 'FAIL', mode, error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; }
}
