import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaskContractSchema } from '@ciag/shared-schemas';
import { sha256 } from '../../tools/prd-compiler/compiler.js';

describe('control-plane-owned immutable task conformance manifests', () => {
  it('binds every task contract to one immutable conformance manifest', async () => {
    const taskIds: string[] = [];
    for (let group = 0; group <= 7; group += 1) {
      const directory = `tasks/G${group}`;
      for (const file of await readdir(directory)) {
        if (!file.endsWith('.contract.json')) continue;
        const task = TaskContractSchema.parse(
          JSON.parse(await readFile(join(directory, file), 'utf8')),
        );
        taskIds.push(task.id);
        expect(task.conformanceManifestPath).toBe(
          `artifacts/conformance/${task.id}/manifest.json`,
        );
        const text = await readFile(task.conformanceManifestPath!, 'utf8');
        expect(sha256(text)).toBe(task.conformanceManifestSha256);
        const manifest = JSON.parse(text) as {
          taskId: string;
          immutable: boolean;
          protectedPaths: string[];
          rejectsTrivialAssertions: boolean;
          requiresChangedProductionBehaviorInvocation: boolean;
        };
        expect(manifest).toMatchObject({
          taskId: task.id,
          immutable: true,
          rejectsTrivialAssertions: true,
          requiresChangedProductionBehaviorInvocation: true,
        });
        expect(manifest.protectedPaths).toContain('tests/conformance/**');
      }
    }
    expect(taskIds).toHaveLength(84);
    expect(new Set(taskIds).size).toBe(taskIds.length);
  });
});
