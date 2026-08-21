/**
 * @requirement FR-AGT-009 - Value-of-information evidence family definitions and metadata.
 * @requirement AC-242 - Evidence not requested by policy is stored as NOT_REQUESTED_BY_POLICY.
 */

export interface EvidenceFamilyDefinition {
  familyId: string;
  description: string;
  tools: readonly string[];
  fieldsProduced: readonly string[];
  questionsResolved: readonly string[];
  estimatedLatencyMs: number;
  estimatedModelContextTokens: number;
  providerQuotaCost: number;
  monetaryCostUsd: number;
  reliability: number;
  freshnessSeconds: number;
  isOptional: boolean;
  defaultPriority: number;
}

export const DEFAULT_EVIDENCE_FAMILIES: readonly EvidenceFamilyDefinition[] = [
  {
    familyId: 'TOKEN_PROFILE',
    description: 'Basic token profile, metadata, symbol, decimals, name, and initial pair mapping',
    tools: ['token.profile', 'dex.pairs'],
    fieldsProduced: ['token.name', 'token.symbol', 'token.decimals', 'token.mint', 'pairs.initial'],
    questionsResolved: ['Is the token contract registered?', 'What are the base trading pairs?'],
    estimatedLatencyMs: 150,
    estimatedModelContextTokens: 300,
    providerQuotaCost: 1,
    monetaryCostUsd: 0.0001,
    reliability: 0.99,
    freshnessSeconds: 3600,
    isOptional: false,
    defaultPriority: 10,
  },
  {
    familyId: 'MARKET_MICROSTRUCTURE',
    description: 'DEX pool liquidity, trade volume, price momentum, screener indicators, and order flow',
    tools: ['dex.screener', 'pool.liquidity'],
    fieldsProduced: ['pool.liquidityUsd', 'pool.volume24h', 'pool.priceUsd', 'pool.feeTier'],
    questionsResolved: ['Does the pool have sufficient depth for trade execution?', 'Is volume real or wash?'],
    estimatedLatencyMs: 250,
    estimatedModelContextTokens: 500,
    providerQuotaCost: 2,
    monetaryCostUsd: 0.0003,
    reliability: 0.95,
    freshnessSeconds: 60,
    isOptional: true,
    defaultPriority: 8,
  },
  {
    familyId: 'CONTRACT_SECURITY',
    description: 'Smart contract audit, bytecode analysis, honeypot scan, mint/freeze authorities, and tax rules',
    tools: ['contract.audit', 'risk.honeypot_scan'],
    fieldsProduced: ['audit.isHoneypot', 'audit.mintAuthorityRenounced', 'audit.freezeAuthorityRenounced', 'audit.buyTaxBps', 'audit.sellTaxBps'],
    questionsResolved: ['Can the token be freely traded?', 'Are there malicious admin backdoors?'],
    estimatedLatencyMs: 400,
    estimatedModelContextTokens: 800,
    providerQuotaCost: 3,
    monetaryCostUsd: 0.0008,
    reliability: 0.98,
    freshnessSeconds: 86400,
    isOptional: true,
    defaultPriority: 9,
  },
  {
    familyId: 'HOLDER_DISTRIBUTION',
    description: 'Token holder concentration, top 10/20 whale share, deployer balance, and distribution entropy',
    tools: ['holder.distribution'],
    fieldsProduced: ['holders.totalCount', 'holders.top10Percentage', 'holders.devPercentage', 'holders.concentrationEntropy'],
    questionsResolved: ['Is token supply dangerously concentrated in insider wallets?'],
    estimatedLatencyMs: 350,
    estimatedModelContextTokens: 600,
    providerQuotaCost: 2,
    monetaryCostUsd: 0.0005,
    reliability: 0.94,
    freshnessSeconds: 300,
    isOptional: true,
    defaultPriority: 7,
  },
  {
    familyId: 'LIQUIDITY_LOCK',
    description: 'LP token burn, lock receipts, timelock duration, and vesting schedule verification',
    tools: ['liquidity.lock'],
    fieldsProduced: ['liquidity.lockedPercentage', 'liquidity.lockDurationDays', 'liquidity.lockContractAddress', 'liquidity.isBurned'],
    questionsResolved: ['Can the deployer pull initial pool liquidity rug?'],
    estimatedLatencyMs: 300,
    estimatedModelContextTokens: 400,
    providerQuotaCost: 2,
    monetaryCostUsd: 0.0004,
    reliability: 0.97,
    freshnessSeconds: 3600,
    isOptional: true,
    defaultPriority: 8,
  },
  {
    familyId: 'TRANSACTION_TRACE',
    description: 'On-chain transaction trace, deployer funder ancestry, wash-trading graphs, and cohort transfer clustering',
    tools: ['solana.transaction_trace'],
    fieldsProduced: ['trace.deployerFunder', 'trace.clusterCohortId', 'trace.priorScamAffiliation', 'trace.washVolumeRatio'],
    questionsResolved: ['Is the deployer connected to known serial scam clusters?'],
    estimatedLatencyMs: 600,
    estimatedModelContextTokens: 1200,
    providerQuotaCost: 5,
    monetaryCostUsd: 0.0015,
    reliability: 0.92,
    freshnessSeconds: 86400,
    isOptional: true,
    defaultPriority: 6,
  },
  {
    familyId: 'SELL_SIMULATION',
    description: 'Executable sell trade simulation, tax enforcement, adverse slippage curve, and quote parity',
    tools: ['simulation.sell', 'simulation.execution'],
    fieldsProduced: ['simulation.sellSuccess', 'simulation.realizedSlippageBps', 'simulation.effectiveTaxBps', 'simulation.gasUsed'],
    questionsResolved: ['Does a simulated sell transaction succeed under current pool liquidity?'],
    estimatedLatencyMs: 500,
    estimatedModelContextTokens: 700,
    providerQuotaCost: 4,
    monetaryCostUsd: 0.0010,
    reliability: 0.96,
    freshnessSeconds: 30,
    isOptional: true,
    defaultPriority: 8,
  },
  {
    familyId: 'HISTORICAL_ANALOG',
    description: 'Historical analog similarity search, outcome pattern matching, and regime cohort trajectory',
    tools: ['signal.score'],
    fieldsProduced: ['analog.similarityScore', 'analog.nearestClusterId', 'analog.expectedWinRate', 'analog.regimeMatch'],
    questionsResolved: ['How have structurally similar setups performed in comparable market regimes?'],
    estimatedLatencyMs: 350,
    estimatedModelContextTokens: 500,
    providerQuotaCost: 2,
    monetaryCostUsd: 0.0005,
    reliability: 0.88,
    freshnessSeconds: 7200,
    isOptional: true,
    defaultPriority: 5,
  },
  {
    familyId: 'SOCIAL_SENTIMENT',
    description: 'Social attention lead-lag metrics, engagement velocity, and bot activity filtering',
    tools: ['market.summary'],
    fieldsProduced: ['social.mentionVelocity', 'social.uniqueAuthors', 'social.botRatio', 'social.sentimentPolarity'],
    questionsResolved: ['Is organic social momentum building prior to price discovery?'],
    estimatedLatencyMs: 300,
    estimatedModelContextTokens: 450,
    providerQuotaCost: 2,
    monetaryCostUsd: 0.0004,
    reliability: 0.85,
    freshnessSeconds: 300,
    isOptional: true,
    defaultPriority: 4,
  },
] as const;

export class EvidenceFamilyRegistry {
  private readonly families = new Map<string, EvidenceFamilyDefinition>();

  constructor(initialFamilies: readonly EvidenceFamilyDefinition[] = DEFAULT_EVIDENCE_FAMILIES) {
    for (const family of initialFamilies) {
      this.register(family);
    }
  }

  public register(family: EvidenceFamilyDefinition): void {
    this.families.set(family.familyId, Object.freeze({ ...family }));
  }

  public get(familyId: string): EvidenceFamilyDefinition | undefined {
    return this.families.get(familyId);
  }

  public require(familyId: string): EvidenceFamilyDefinition {
    const family = this.get(familyId);
    if (!family) {
      throw new Error(`Unknown evidence family: "${familyId}"`);
    }
    return family;
  }

  public list(): EvidenceFamilyDefinition[] {
    return [...this.families.values()];
  }

  public listOptional(): EvidenceFamilyDefinition[] {
    return this.list().filter((f) => f.isOptional);
  }

  public findByTool(toolName: string): EvidenceFamilyDefinition[] {
    return this.list().filter((f) => f.tools.includes(toolName));
  }
}
