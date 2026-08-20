import type { ModelProfile } from '@ciag/shared-schemas';
import { ModelProfileSchema } from '@ciag/shared-schemas';
import { UnknownModelProfileError } from './errors.js';

export const DEFAULT_MODEL_PROFILES: readonly ModelProfile[] = [
  {
    id: 'fast-triage-v1',
    version: '1.0.0',
    modelClass: 'TRIAGE',
    provider: 'google',
    modelId: 'gemini-1.5-flash',
    declaredTools: ['dex.pairs', 'token.profile', 'market.summary'],
    maxTokens: 2048,
    maxContextTokens: 32768,
    temperature: 0,
    costPerInputTokenUsd: 0.0000001,
    costPerOutputTokenUsd: 0.0000004,
  },
  {
    id: 'deep-research-v1',
    version: '1.0.0',
    modelClass: 'DEEP_RESEARCH',
    provider: 'anthropic',
    modelId: 'claude-3-5-sonnet',
    declaredTools: [
      'dex.pairs',
      'dex.screener',
      'token.profile',
      'holder.distribution',
      'contract.audit',
      'solana.transaction_trace',
      'pool.liquidity',
      'signal.score',
      'simulation.execution',
    ],
    maxTokens: 8192,
    maxContextTokens: 128000,
    temperature: 0,
    costPerInputTokenUsd: 0.000003,
    costPerOutputTokenUsd: 0.000015,
  },
  {
    id: 'skeptic-v1',
    version: '1.0.0',
    modelClass: 'SKEPTIC',
    provider: 'deepseek',
    modelId: 'deepseek-reasoner',
    declaredTools: [
      'contract.audit',
      'holder.distribution',
      'liquidity.lock',
      'simulation.sell',
      'risk.honeypot_scan',
    ],
    maxTokens: 4096,
    maxContextTokens: 64000,
    temperature: 0,
    costPerInputTokenUsd: 0.0000005,
    costPerOutputTokenUsd: 0.000002,
  },
  {
    id: 'admin-chat-v1',
    version: '1.0.0',
    modelClass: 'ADMIN_CHAT',
    provider: 'anthropic',
    modelId: 'claude-3-5-sonnet',
    declaredTools: [
      'schedule.inspect',
      'candidate.inspect',
      'run.inspect',
      'alert.inspect',
      'incident.list',
    ],
    maxTokens: 4096,
    maxContextTokens: 64000,
    temperature: 0,
    costPerInputTokenUsd: 0.000003,
    costPerOutputTokenUsd: 0.000015,
  },
  {
    id: 'repair-v1',
    version: '1.0.0',
    modelClass: 'REPAIR',
    provider: 'google',
    modelId: 'gemini-1.5-flash',
    declaredTools: [],
    maxTokens: 4096,
    maxContextTokens: 32768,
    temperature: 0,
    costPerInputTokenUsd: 0.0000001,
    costPerOutputTokenUsd: 0.0000004,
  },
] as const;

export class ModelProfileRegistry {
  private readonly profiles = new Map<string, ModelProfile>();

  constructor(initialProfiles: readonly ModelProfile[] = DEFAULT_MODEL_PROFILES) {
    for (const profile of initialProfiles) {
      this.register(profile);
    }
  }

  private makeKey(id: string, version?: string): string {
    return version ? `${id}@${version}` : id;
  }

  register(profile: ModelProfile): void {
    const validated = ModelProfileSchema.parse(profile);
    const keyWithVersion = `${validated.id}@${validated.version}`;
    this.profiles.set(keyWithVersion, structuredClone(validated));
    // Also index without version to allow resolving default/latest registered
    this.profiles.set(validated.id, structuredClone(validated));
  }

  get(id: string, version?: string): ModelProfile | undefined {
    const key = this.makeKey(id, version);
    const found = this.profiles.get(key);
    return found ? structuredClone(found) : undefined;
  }

  /**
   * Requires a model profile by ID (and optional version).
   * Fails closed by throwing UnknownModelProfileError on unknown profile.
   */
  require(id: string, version?: string): ModelProfile {
    const profile = this.get(id, version);
    if (!profile) {
      throw new UnknownModelProfileError(id, version);
    }
    return profile;
  }

  list(): ModelProfile[] {
    const unique = new Map<string, ModelProfile>();
    for (const [key, profile] of this.profiles.entries()) {
      if (key.includes('@')) {
        unique.set(key, structuredClone(profile));
      }
    }
    return [...unique.values()];
  }

  isToolAllowed(profileId: string, toolName: string, version?: string): boolean {
    const profile = this.get(profileId, version);
    if (!profile) return false;
    return profile.declaredTools.includes(toolName);
  }

  validateDeclaredTools(
    profileId: string,
    requestedTools: readonly string[],
    version?: string,
  ): { valid: boolean; unauthorizedTools: string[] } {
    const profile = this.require(profileId, version);
    const unauthorizedTools = requestedTools.filter(
      (tool) => !profile.declaredTools.includes(tool),
    );
    return {
      valid: unauthorizedTools.length === 0,
      unauthorizedTools,
    };
  }
}
