import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const raw = process.env.CHAINSIEVE_MUSE_SUPERVISOR_CONFIG;
if (!raw) throw new Error('MUSE_SUPERVISOR_CONFIG_MISSING');
const config = JSON.parse(raw);

const startedAt = Date.now();
let lastWorkspaceProgressAt = startedAt;
let retrySignals = 0;
let lastFingerprint = '';
let commitSeenAt;
let stopping = false;

const git = (args) => {
  const result = spawnSync('git', args, {
    cwd: config.workspace,
    encoding: 'utf8',
    timeout: 10_000,
  });
  return result.status === 0 ? result.stdout.trim() : '';
};

const commonGitDirectory = () => {
  const value = git(['rev-parse', '--git-common-dir']);
  if (!value) return undefined;
  return resolve(config.workspace, isAbsolute(value) ? value : join(config.workspace, value));
};

const lifecycleState = () => {
  if (!config.taskId) return undefined;
  const common = commonGitDirectory();
  if (!common) return undefined;
  const path = join(common, 'ciag-runtime', 'task-state.json');
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')).tasks?.[config.taskId]?.state;
  } catch {
    return undefined;
  }
};

const workspaceFingerprint = () => {
  const head = git(['rev-parse', 'HEAD']);
  const status = git(['status', '--porcelain=v1']);
  return `${head}\n${status}`;
};

const cleanAtomicCommit = () => {
  if (!config.taskId || !config.baseCommit) return false;
  if (git(['status', '--porcelain=v1'])) return false;
  const head = git(['rev-parse', 'HEAD']);
  if (!head || head === config.baseCommit) return false;
  return Number(git(['rev-list', '--count', `${config.baseCommit}..${head}`])) === 1;
};

const retrySignal = (line) =>
  /retrying meta model stream|rate.?limit|temporar(?:y|ily) unavailable|overload(?:ed)?|upstream.*(?:timeout|unavailable)/i.test(
    line,
  );

const checkpointState = (state) =>
  ['SELF_REVIEWING', 'VERIFYING', 'VERIFIED', 'MERGE_QUEUED', 'MERGED'].includes(
    state ?? '',
  );

const child = spawn(config.command, config.args, {
  cwd: config.workspace,
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

const forward = (stream, target) => {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    target.write(chunk);
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (retrySignal(line)) {
        retrySignals += 1;
        console.error(
          `CHAINSIEVE_MUSE_RETRY_SIGNAL:${config.taskId ?? 'semantic-session'}:${retrySignals}`,
        );
      }
    }
  });
};
forward(child.stdout, process.stdout);
forward(child.stderr, process.stderr);

const stop = (exitCode, marker) => {
  if (stopping) return;
  stopping = true;
  console.error(marker);
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 10_000);
  force.unref();
  child.once('close', () => process.exit(exitCode));
};

const monitor = setInterval(() => {
  const now = Date.now();
  const fingerprint = workspaceFingerprint();
  if (fingerprint && fingerprint !== lastFingerprint) {
    lastFingerprint = fingerprint;
    lastWorkspaceProgressAt = now;
    retrySignals = 0;
    console.error(
      `CHAINSIEVE_MUSE_PROGRESS:${config.taskId ?? 'semantic-session'}`,
    );
  }

  const state = lifecycleState();
  if (checkpointState(state)) {
    stop(
      72,
      `CHAINSIEVE_MUSE_CHECKPOINT_OBSERVED:${config.taskId}:${state}`,
    );
    return;
  }

  if (cleanAtomicCommit()) {
    commitSeenAt ??= now;
    if (now - commitSeenAt >= config.commitGraceMilliseconds) {
      stop(
        72,
        `CHAINSIEVE_MUSE_COMMIT_GRACE_EXPIRED:${config.taskId}:${git(['rev-parse', 'HEAD'])}`,
      );
      return;
    }
  } else {
    commitSeenAt = undefined;
  }

  if (
    retrySignals >= config.retryStormLimit &&
    now - lastWorkspaceProgressAt >= config.retryStallMilliseconds
  ) {
    stop(
      75,
      `CHAINSIEVE_MUSE_CIRCUIT_OPEN:${config.taskId ?? 'semantic-session'}:retry-storm:${retrySignals}`,
    );
    return;
  }

  if (now - startedAt >= config.hardTimeoutMilliseconds) {
    stop(
      76,
      `CHAINSIEVE_MUSE_CIRCUIT_OPEN:${config.taskId ?? 'semantic-session'}:hard-timeout`,
    );
  }
}, 5_000);
monitor.unref();

child.on('error', (error) => {
  clearInterval(monitor);
  console.error(`MUSE_SUPERVISOR_CHILD_ERROR:${error.message}`);
  process.exit(1);
});

child.on('close', (code, signal) => {
  if (stopping) return;
  clearInterval(monitor);
  if (signal) console.error(`MUSE_SUPERVISOR_CHILD_SIGNAL:${signal}`);
  process.exit(code ?? 1);
});
