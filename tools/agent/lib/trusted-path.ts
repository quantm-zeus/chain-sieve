import { constants, type Dirent, type Stats } from 'node:fs';
import { lstat, open, realpath, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export type TrustedPathOperation =
  | 'LSTAT_DIRECTORY'
  | 'LSTAT_DIRECTORY_COMPONENT'
  | 'REALPATH_DIRECTORY'
  | 'LSTAT_FILE'
  | 'REALPATH_FILE'
  | 'OPEN_FILE'
  | 'VALIDATE_CONTAINMENT';

export class TrustedPathError extends Error {
  readonly code = 'TRUSTED_PATH_CONTAINMENT';
  readonly operation: TrustedPathOperation;
  readonly logicalBindingName: string;
  readonly requestedPath: string;
  readonly trustedRoot: string;
  readonly filesystemCauseCode: string | undefined;
  override readonly cause: unknown;

  constructor(options: {
    operation: TrustedPathOperation;
    logicalBindingName: string;
    requestedPath: string;
    trustedRoot: string;
    detail: string;
    filesystemCauseCode?: string;
    cause?: unknown;
  }) {
    super(`TRUSTED_PATH_CONTAINMENT:${options.logicalBindingName}:${options.detail}`);
    this.name = 'TrustedPathError';
    this.operation = options.operation;
    this.logicalBindingName = options.logicalBindingName;
    this.requestedPath = options.requestedPath;
    this.trustedRoot = options.trustedRoot;
    this.filesystemCauseCode = options.filesystemCauseCode;
    this.cause = options.cause;
  }
}

const containmentError = (
  label: string,
  detail: string,
  context: {
    operation?: TrustedPathOperation;
    requestedPath?: string;
    trustedRoot?: string;
    filesystemCauseCode?: string;
    cause?: unknown;
  } = {},
): TrustedPathError => new TrustedPathError({
  operation: context.operation ?? 'VALIDATE_CONTAINMENT',
  logicalBindingName: label,
  requestedPath: context.requestedPath ?? '',
  trustedRoot: context.trustedRoot ?? '',
  detail,
  ...(context.filesystemCauseCode ? { filesystemCauseCode: context.filesystemCauseCode } : {}),
  ...(context.cause !== undefined ? { cause: context.cause } : {}),
});

export const isTrustedPathFilesystemError = (
  error: unknown,
  filesystemCauseCode: string,
): error is TrustedPathError =>
  error instanceof TrustedPathError && error.filesystemCauseCode === filesystemCauseCode;

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
    const causeCode = (error as NodeJS.ErrnoException).code;
    throw containmentError(label, causeCode ?? 'LSTAT_FAILED', {
      operation: 'LSTAT_DIRECTORY', requestedPath: lexical, trustedRoot: lexical,
      ...(causeCode ? { filesystemCauseCode: causeCode } : {}), cause: error,
    });
  });
  if (info.isSymbolicLink()) throw containmentError(label, 'SYMLINK_DIRECTORY');
  if (!info.isDirectory()) throw containmentError(label, 'NOT_DIRECTORY');
  const canonical = await realpath(lexical).catch(() => {
    throw containmentError(label, 'REALPATH_FAILED', {
      operation: 'REALPATH_DIRECTORY', requestedPath: lexical, trustedRoot: lexical,
    });
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
      const causeCode = (error as NodeJS.ErrnoException).code;
      throw containmentError(label, causeCode ?? 'LSTAT_FAILED', {
        operation: 'LSTAT_DIRECTORY_COMPONENT', requestedPath: current, trustedRoot: canonicalRoot,
        ...(causeCode ? { filesystemCauseCode: causeCode } : {}), cause: error,
      });
    }
    if (info.isSymbolicLink()) throw containmentError(label, 'SYMLINK_DIRECTORY');
    if (!info.isDirectory()) throw containmentError(label, 'NOT_DIRECTORY');
  }
  const canonical = await realpath(lexical).catch(() => {
    throw containmentError(label, 'REALPATH_FAILED', {
      operation: 'REALPATH_DIRECTORY', requestedPath: lexical, trustedRoot: canonicalRoot,
    });
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
    const causeCode = (error as NodeJS.ErrnoException).code;
    throw containmentError(label, causeCode ?? 'LSTAT_FAILED', {
      operation: 'LSTAT_FILE', requestedPath: requested, trustedRoot: canonicalRoot,
      ...(causeCode ? { filesystemCauseCode: causeCode } : {}), cause: error,
    });
  });
  if (requestedInfo.isSymbolicLink()) throw containmentError(label, 'SYMLINK_FILE');
  const canonical = await realpath(requested).catch(() => {
    throw containmentError(label, 'REALPATH_FAILED', {
      operation: 'REALPATH_FILE', requestedPath: requested, trustedRoot: canonicalRoot,
    });
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
    const causeCode = (error as NodeJS.ErrnoException).code;
    throw containmentError(label, causeCode ?? 'OPEN_FAILED', {
      operation: 'OPEN_FILE', requestedPath: lexical, trustedRoot: canonicalRoot,
      ...(causeCode ? { filesystemCauseCode: causeCode } : {}), cause: error,
    });
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
