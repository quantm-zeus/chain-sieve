import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { verifyTask } from '../../tools/task-verifier/verify.js';

describe('completion forgery rejection', () => {
  it('rejects task completion without a live lease, task branch and atomic commit', async () => { await expect(verifyTask('T-G0-CORE', 'forged', 1)).rejects.toThrow('NO_ACTIVE_LEASE'); });
  it('rejects cluster completion while constituent tasks are not merged', () => { const result = spawnSync('pnpm', ['cluster:verify', 'C-G0-IMPLEMENTATION'], { encoding: 'utf8' }); expect(result.status).not.toBe(0); expect(`${result.stdout}${result.stderr}`).toContain('CLUSTER_TASK_NOT_MERGED'); });
});
