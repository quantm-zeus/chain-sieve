import { describe, expect, it } from 'vitest';
import { errorCode, ZCodeError } from '../../tools/zcode/lib/errors.js';

describe('ZCode error rendering', () => {
  it('renders the command and lower-level structured cause', () => {
    const rendered = errorCode(
      new ZCodeError(
        'TASK_WORKTREE_CREATE_FAILED',
        'pnpm worktree:create T-G0-CORE',
        ['{"status":"FAIL","error":"WORKTREE_EXISTS"}'],
      ),
    );

    expect(rendered).toBe(
      [
        'TASK_WORKTREE_CREATE_FAILED',
        'Command: pnpm worktree:create T-G0-CORE',
        'Cause: WORKTREE_EXISTS',
      ].join('\n'),
    );
  });

  it('redacts and truncates potentially sensitive command details', () => {
    const rendered = errorCode(
      new ZCodeError('FAILED', undefined, [
        `authorization: Bearer very-secret token=${'x'.repeat(800)}`,
      ]),
    );

    expect(rendered).not.toContain('very-secret');
    expect(rendered).not.toContain('x'.repeat(600));
    expect(rendered).toContain('[REDACTED]');
  });

  it('redacts underscore-delimited environment secret keys', () => {
    const rendered = errorCode(
      new ZCodeError('FAILED', undefined, [
        [
          'GH_TOKEN=ghp_one',
          'GITHUB_TOKEN=ghp_two',
          'OPENAI_API_KEY=sk-three',
          'AWS_SECRET_ACCESS_KEY=four',
        ].join(' '),
      ]),
    );

    for (const secret of ['ghp_one', 'ghp_two', 'sk-three', 'four'])
      expect(rendered).not.toContain(secret);
    expect(rendered.match(/\[REDACTED]/g)).toHaveLength(4);
  });
});
