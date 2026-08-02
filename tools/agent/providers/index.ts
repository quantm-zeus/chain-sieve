import { AgentError } from '../lib/errors.js';
import type {
  AgentProvider,
  AgentProviderId,
  CommandRunner,
} from '../lib/types.js';
import { AntigravityProvider } from './antigravity.js';
import { CodexProvider } from './codex.js';
import { ZCodeProvider } from './zcode.js';

export const DEFAULT_AGENT_PROVIDER: AgentProviderId = 'antigravity';

export const createProvider = (
  id: AgentProviderId,
  runner: CommandRunner,
): AgentProvider => {
  if (id === 'antigravity') return new AntigravityProvider(runner);
  if (id === 'codex') return new CodexProvider(runner);
  if (id === 'zcode') return new ZCodeProvider(runner);
  throw new AgentError('UNKNOWN_AGENT_PROVIDER', id);
};

export const parseProvider = (argv: string[]): AgentProviderId => {
  const index = argv.indexOf('--provider');
  const value = index < 0 ? DEFAULT_AGENT_PROVIDER : argv[index + 1];
  if (value !== 'antigravity' && value !== 'codex' && value !== 'zcode')
    throw new AgentError('UNKNOWN_AGENT_PROVIDER', value ?? 'missing');
  return value;
};
