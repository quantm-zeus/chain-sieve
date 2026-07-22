import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('prompt provenance', () => {
  it('binds each exact archived prompt by SHA-256 without fabricating execution dates', async () => {
    const manifest = JSON.parse(await readFile('docs/prompts/prompt-manifest.json', 'utf8')) as {
      prompts: Array<{ path: string; sha256: string; source: string; original_execution_date?: string }>;
    };
    expect(manifest.prompts).toHaveLength(2);
    for (const prompt of manifest.prompts) {
      const bytes = await readFile(prompt.path);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(prompt.sha256);
      expect(prompt.source).toContain('pre-existing owner-provided workspace file');
      expect(prompt.original_execution_date).toBeUndefined();
    }
  });
});
