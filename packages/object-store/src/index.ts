import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import type { ObjectStoreAdapter } from '@ciag/provider-contracts';

const hash = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
const safeKey = (key: string): string => { if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(key) || key.includes('..')) throw new Error('INVALID_OBJECT_KEY'); return key; };

export class FilesystemObjectStore implements ObjectStoreAdapter {
  constructor(private readonly root: string) {}
  async put(key: string, data: Uint8Array): Promise<{ key: string; sha256: string }> { const target = resolve(this.root, safeKey(key)); await mkdir(dirname(target), { recursive: true }); await writeFile(target, data, { flag: 'wx' }).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }); return { key, sha256: hash(data) }; }
  async get(key: string): Promise<Uint8Array | undefined> { try { return await readFile(resolve(this.root, safeKey(key))); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; } }
  async exists(key: string): Promise<boolean> { return (await this.get(key)) !== undefined; }
  async ready(): Promise<boolean> { try { await mkdir(this.root, { recursive: true }); return true; } catch { return false; } }
}

export class FakeObjectStore implements ObjectStoreAdapter {
  readonly objects = new Map<string, Uint8Array>();
  failNext = false;
  async put(key: string, data: Uint8Array): Promise<{ key: string; sha256: string }> { if (this.failNext) { this.failNext = false; throw new Error('INJECTED_OBJECT_STORE_FAILURE'); } if (!this.objects.has(key)) this.objects.set(key, data.slice()); return { key, sha256: hash(data) }; }
  async get(key: string): Promise<Uint8Array | undefined> { return this.objects.get(key)?.slice(); }
  async exists(key: string): Promise<boolean> { return this.objects.has(key); }
  async ready(): Promise<boolean> { return true; }
}

export class S3ObjectStore implements ObjectStoreAdapter {
  private readonly client: S3Client;
  constructor(private readonly bucket: string, config: S3ClientConfig) { this.client = new S3Client(config); }
  async put(key: string, data: Uint8Array, metadata: Record<string, string> = {}): Promise<{ key: string; sha256: string }> { const digest = hash(data); await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: safeKey(key), Body: data, Metadata: { ...metadata, sha256: digest }, IfNoneMatch: '*' })); return { key, sha256: digest }; }
  async get(key: string): Promise<Uint8Array | undefined> { try { const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: safeKey(key) })); return response.Body ? await response.Body.transformToByteArray() : undefined; } catch (error: unknown) { const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode; if (status === 404) return undefined; throw error; } }
  async exists(key: string): Promise<boolean> { try { await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: safeKey(key) })); return true; } catch (error: unknown) { const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode; if (status === 404) return false; throw error; } }
  async ready(): Promise<boolean> { try { await this.client.send(new HeadBucketCommand({ Bucket: this.bucket })); return true; } catch (error: unknown) { void error; return false; } }
}
