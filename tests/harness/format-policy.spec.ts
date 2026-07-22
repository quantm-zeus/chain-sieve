import { describe, expect, it } from 'vitest';
import { formatViolations, isOwnedFormattingPath, normalizeOwnedText } from '../../tools/task-verifier/format.js';

describe('owned-file formatting policy', () => {
  it('covers maintained source and tests while excluding immutable and content-addressed files', () => {
    expect(isOwnedFormattingPath('apps/api/src/app.ts')).toBe(true);
    expect(isOwnedFormattingPath('tests/unit/api.spec.ts')).toBe(true);
    expect(isOwnedFormattingPath('docs/spec/crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.md')).toBe(false);
    expect(isOwnedFormattingPath('artifacts/release-attestation/harness-v1.0.0/evidence.json')).toBe(false);
    expect(isOwnedFormattingPath('tasks/generated/graph.json')).toBe(false);
    expect(isOwnedFormattingPath('pnpm-lock.yaml')).toBe(false);
  });
  it('detects and deterministically repairs repository formatting defects', () => {
    expect(formatViolations('apps/api/src/example.ts', 'const value = 1;  \r\n')).toEqual(['CRLF_OR_CR', 'TRAILING_WHITESPACE']);
    expect(normalizeOwnedText('const value = 1;  \r\n')).toBe('const value = 1;\n');
  });
});
