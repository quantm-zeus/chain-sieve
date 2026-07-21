import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FilesystemObjectStore } from '@ciag/object-store';

describe('filesystem object-store integrity', () => {
  const roots: string[] = [];
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
  it('is immutable and returns the persisted content hash', async () => { const base = await mkdtemp(join(tmpdir(), 'ciag-object-store-')); roots.push(base); const store = new FilesystemObjectStore(join(base, 'root')); await store.put('evidence/item.json', new TextEncoder().encode('first')); await expect(store.put('evidence/item.json', new TextEncoder().encode('second'))).rejects.toThrow('OBJECT_IMMUTABILITY_CONFLICT'); expect(new TextDecoder().decode(await store.get('evidence/item.json'))).toBe('first'); });
  it('rejects intermediate symlinks that escape the configured root', async () => { const base = await mkdtemp(join(tmpdir(), 'ciag-object-store-')); roots.push(base); const root = join(base, 'root'); const outside = join(base, 'outside'); await mkdir(root); await mkdir(outside); await symlink(outside, join(root, 'escape')); const store = new FilesystemObjectStore(root); await expect(store.put('escape/payload', new TextEncoder().encode('blocked'))).rejects.toThrow(/OBJECT_STORE_(?:PATH_ESCAPE|SYMLINK_FORBIDDEN)/); });
});
