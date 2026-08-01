import { constants, type Dirent, type Stats } from 'node:fs';
import { lstat, open, realpath, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const containmentError = (label: string, detail: string): Error =>
  new Error(`TRUSTED_PATH_CONTAINMENT:${label}:${detail}`);

const contained = (root: string, target: string): boolean => {
  const value = relative(root, target);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
};

const sameIdentity = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

export const canonicalTrustedDirectory = async (
  directory: string,
  label: string,
): Promise<string> => {
  const lexical = resolve(directory);
  const info = await lstat(lexical).catch((error: unknown) => {
    throw containmentError(label, (error as NodeJS.ErrnoException).code ?? 'LSTAT_FAILED');
  });
  if (info.isSymbolicLink()) throw containmentError(label, 'SYMLINK_DIRECTORY');
  if (!info.isDirectory()) throw containmentError(label, 'NOT_DIRECTORY');
  const canonical = await realpath(lexical).catch(() => {
    throw containmentError(label, 'REALPATH_FAILED');
  });
  const canonicalInfo = await lstat(canonical);
  if (canonicalInfo.isSymbolicLink() || !canonicalInfo.isDirectory())
    throw containmentError(label, 'CANONICAL_DIRECTORY_INVALID');
  return canonical;
};

const walkDirectoryComponents = async (
  canonicalRoot: string,
  targetDirectory: string,
  label: string,
  allowMissing: boolean,
): Promise<string | undefined> => {
  const lexical = resolve(targetDirectory);
  if (!contained(canonicalRoot, lexical)) throw containmentError(label, 'ROOT_ESCAPE');
  const suffix = relative(canonicalRoot, lexical);
  let current = canonicalRoot;
  for (const component of suffix === '' ? [] : suffix.split(sep)) {
    if (!component || component === '.' || component === '..')
      throw containmentError(label, 'INVALID_COMPONENT');
    current = resolve(current, component);
    let info: Stats;
    try {
      info = await lstat(current);
    } catch (error: unknown) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw containmentError(label, (error as NodeJS.ErrnoException).code ?? 'LSTAT_FAILED');
    }
    if (info.isSymbolicLink()) throw containmentError(label, 'SYMLINK_DIRECTORY');
    if (!info.isDirectory()) throw containmentError(label, 'NOT_DIRECTORY');
  }
  const canonical = await realpath(lexical).catch(() => {
    throw containmentError(label, 'REALPATH_FAILED');
  });
  if (!contained(canonicalRoot, canonical)) throw containmentError(label, 'CANONICAL_ROOT_ESCAPE');
  if (canonical !== lexical) throw containmentError(label, 'DIRECTORY_ALIAS');
  return canonical;
};

export const canonicalTrustedSubdirectory = async (
  root: string,
  directory: string,
  label: string,
  allowMissing = false,
): Promise<string | undefined> => {
  const canonicalRoot = await canonicalTrustedDirectory(root, `${label}:ROOT`);
  return walkDirectoryComponents(canonicalRoot, directory, label, allowMissing);
};

export const listTrustedDirectory = async (
  root: string,
  directory: string,
  label: string,
): Promise<{ canonicalRoot: string; canonicalDirectory?: string; entries: Dirent[] }> => {
  const canonicalRoot = await canonicalTrustedDirectory(root, `${label}:ROOT`);
  const canonicalDirectory = await walkDirectoryComponents(canonicalRoot, directory, label, true);
  if (!canonicalDirectory) return { canonicalRoot, entries: [] };
  const entries = await readdir(canonicalDirectory, { withFileTypes: true });
  for (const entry of entries)
    if (entry.isSymbolicLink()) throw containmentError(label, `SYMLINK_ENTRY:${entry.name}`);
  return { canonicalRoot, canonicalDirectory, entries };
};

export const readTrustedFile = async (
  root: string,
  candidate: string,
  label: string,
): Promise<Buffer> => {
  const canonicalRoot = await canonicalTrustedDirectory(root, `${label}:ROOT`);
  const requested = resolve(isAbsolute(candidate) ? candidate : resolve(canonicalRoot, candidate));
  if (contained(canonicalRoot, requested))
    await walkDirectoryComponents(canonicalRoot, dirname(requested), `${label}:REQUESTED_PARENT`, false);
  const requestedInfo = await lstat(requested).catch((error: unknown) => {
    throw containmentError(label, (error as NodeJS.ErrnoException).code ?? 'LSTAT_FAILED');
  });
  if (requestedInfo.isSymbolicLink()) throw containmentError(label, 'SYMLINK_FILE');
  const canonical = await realpath(requested).catch(() => {
    throw containmentError(label, 'REALPATH_FAILED');
  });
  if (!contained(canonicalRoot, canonical)) throw containmentError(label, 'CANONICAL_ROOT_ESCAPE');
  const lexical = canonical;
  const canonicalParent = await walkDirectoryComponents(canonicalRoot, dirname(lexical), `${label}:PARENT`, false);
  if (!canonicalParent) throw containmentError(label, 'PARENT_MISSING');
  const before = await lstat(lexical);
  if (before.isSymbolicLink()) throw containmentError(label, 'SYMLINK_FILE');
  if (!before.isFile()) throw containmentError(label, 'NOT_REGULAR_FILE');
  if (before.nlink !== 1) throw containmentError(label, 'HARD_LINK_AMBIGUITY');
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(lexical, constants.O_RDONLY | noFollow);
  } catch (error: unknown) {
    throw containmentError(label, (error as NodeJS.ErrnoException).code ?? 'OPEN_FAILED');
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameIdentity(before, opened))
      throw containmentError(label, 'IDENTITY_CHANGED_BEFORE_READ');
    const content = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstat(lexical).catch(() => undefined);
    if (!sameIdentity(opened, after) || !pathAfter || !sameIdentity(after, pathAfter))
      throw containmentError(label, 'IDENTITY_CHANGED_DURING_READ');
    return content;
  } finally {
    await handle.close();
  }
};
