import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import type { ObjectStoreAdapter } from '@ciag/provider-contracts';

const hash = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
const safeKey = (key: string): string => { if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(key) || key.includes('..')) throw new Error('INVALID_OBJECT_KEY'); return key; };
const isInside = (root: string, target: string): boolean => target === root || (!relative(root, target).startsWith(`..${sep}`) && relative(root, target) !== '..' && !relative(root, target).startsWith(sep));

export class FilesystemObjectStore implements ObjectStoreAdapter {
  private readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  private target(key: string): string { const target = resolve(this.root, safeKey(key)); if (!isInside(this.root, target) || target === this.root) throw new Error('INVALID_OBJECT_KEY'); return target; }
  private async assertSafeParent(target: string): Promise<void> {
    await mkdir(this.root, { recursive: true });
    if ((await lstat(this.root)).isSymbolicLink()) throw new Error('OBJECT_STORE_ROOT_SYMLINK');
    const canonicalRoot = await realpath(this.root);
    await mkdir(dirname(target), { recursive: true });
    const parent = await realpath(dirname(target));
    if (!isInside(canonicalRoot, parent)) throw new Error('OBJECT_STORE_PATH_ESCAPE');
    let current = this.root;
    for (const segment of relative(this.root, dirname(target)).split(sep).filter(Boolean)) { current = resolve(current, segment); if ((await lstat(current)).isSymbolicLink()) throw new Error('OBJECT_STORE_SYMLINK_FORBIDDEN'); }
  }
  async put(key: string, data: Uint8Array): Promise<{ key: string; sha256: string }> {
    const target = this.target(key); await this.assertSafeParent(target); const digest = hash(data);
    try { const handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); try { await handle.writeFile(data); } finally { await handle.close(); } }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stat = await lstat(target); if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('OBJECT_STORE_SYMLINK_FORBIDDEN');
      const existing = await readFile(target); if (hash(existing) !== digest) throw new Error('OBJECT_IMMUTABILITY_CONFLICT');
    }
    return { key, sha256: digest };
  }
  async get(key: string): Promise<Uint8Array | undefined> { const target = this.target(key); try { await this.assertSafeParent(target); const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW); try { return await handle.readFile(); } finally { await handle.close(); } } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; } }
  async exists(key: string): Promise<boolean> { return (await this.get(key)) !== undefined; }
  async ready(): Promise<boolean> { try { await mkdir(this.root, { recursive: true }); if ((await lstat(this.root)).isSymbolicLink()) return false; await access(this.root, constants.R_OK | constants.W_OK); return true; } catch { return false; } }
}

export class FakeObjectStore implements ObjectStoreAdapter {
  readonly objects = new Map<string, Uint8Array>();
  failNext = false;
  async put(key: string, data: Uint8Array): Promise<{ key: string; sha256: string }> { if (this.failNext) { this.failNext = false; throw new Error('INJECTED_OBJECT_STORE_FAILURE'); } const existing = this.objects.get(key); if (existing && hash(existing) !== hash(data)) throw new Error('OBJECT_IMMUTABILITY_CONFLICT'); if (!existing) this.objects.set(key, data.slice()); return { key, sha256: hash(data) }; }
  async get(key: string): Promise<Uint8Array | undefined> { return this.objects.get(key)?.slice(); }
  async exists(key: string): Promise<boolean> { return this.objects.has(key); }
  async ready(): Promise<boolean> { return true; }
}

export class S3ObjectStore implements ObjectStoreAdapter {
  private readonly client: S3Client;
  constructor(private readonly bucket: string, config: S3ClientConfig) { this.client = new S3Client(config); }
  async put(key: string, data: Uint8Array, metadata: Record<string, string> = {}): Promise<{ key: string; sha256: string }> { const digest = hash(data); try { await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: safeKey(key), Body: data, Metadata: { ...metadata, sha256: digest }, IfNoneMatch: '*' })); } catch (error: unknown) { const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode; if (status !== 412) throw error; const existing = await this.get(key); if (!existing || hash(existing) !== digest) throw new Error('OBJECT_IMMUTABILITY_CONFLICT'); } return { key, sha256: digest }; }
  async get(key: string): Promise<Uint8Array | undefined> { try { const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: safeKey(key) })); return response.Body ? await response.Body.transformToByteArray() : undefined; } catch (error: unknown) { const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode; if (status === 404) return undefined; throw error; } }
  async exists(key: string): Promise<boolean> { try { await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: safeKey(key) })); return true; } catch (error: unknown) { const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode; if (status === 404) return false; throw error; } }
  async ready(): Promise<boolean> { try { await this.client.send(new HeadBucketCommand({ Bucket: this.bucket })); return true; } catch (error: unknown) { void error; return false; } }
}
