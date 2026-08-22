/**
 * @requirement FR-AGT-009 - Value-of-information evidence family definitions and metadata.
 * @requirement AC-242 - Evidence not requested by policy is stored as NOT_REQUESTED_BY_POLICY.
 * @requirement FR-DATA-011 - Distinct evidence acquisition states
 * @requirement FR-DATA-012 - Structured evidence acquisition records
 */

export interface EvidenceFamilyDefinition {
  familyId: string;
  id?: string;
  name?: string;
  description: string;
  tools: readonly string[];
  associatedTools?: readonly string[];
  fieldsProduced: readonly string[];
  standardFields?: readonly string[];
  questionsResolved?: readonly string[];
  estimatedLatencyMs?: number;
  estimatedModelContextTokens?: number;
  providerQuotaCost: number;
  defaultQuotaUnits?: number;
  monetaryCostUsd: number;
  defaultMonetaryCostUsd?: number;
  reliability: number;
  freshnessSeconds?: number;
  isOptional: boolean;
  defaultPriority?: number;
  defaultDecisionImpact?: 'HIGH' | 'MEDIUM' | 'LOW';
  estimatedImpactScore?: number;
  probabilityStateChange?: number;
  independenceValue?: number;
  isMandatoryForGoals?: readonly string[];
}

export const DEFAULT_EVIDENCE_FAMILIES: readonly EvidenceFamilyDefinition[] = [
  {
    familyId: 'TOKEN_PROFILE',
    id: 'TOKEN_PROFILE',
    name: 'Token Metadata & Profile',
    description: 'Basic token profile, metadata, symbol, decimals, name, and initial pair mapping',
    tools: ['token.profile', 'dex.pairs'],
    associatedTools: ['token.profile', 'dex.pairs'],
    fieldsProduced: ['token.name', 'token.symbol', 'token.decimals', 'token.mint', 'pairs.initial'],
    standardFields: ['token.name', 'token.symbol', 'token.decimals', 'token.mint', 'pairs.initial'],
    questionsResolved: ['Is the token contract registered?', 'What are the base trading pairs?'],
    estimatedLatencyMs: 150,
    estimatedModelContextTokens: 300,
    providerQuotaCost: 1,
    defaultQuotaUnits: 1,
    monetaryCostUsd: 0.0001,
    defaultMonetaryCostUsd: 0.0001,
    reliability: 0.99,
    freshnessSeconds: 3600,
    isOptional: false,
    defaultPriority: 10,
    defaultDecisionImpact: 'MEDIUM',
    estimatedImpactScore: 0.6,
    probabilityStateChange: 0.4,
    independenceValue: 0.9,
    isMandatoryForGoals: ['TRIAGE', 'DEEP_RESEARCH'],
  },
  {
    familyId: 'MARKET_MICROSTRUCTURE',
    id: 'MARKET_MICROSTRUCTURE',
    name: 'Market Microstructure & Liquidity',
    description: 'DEX pool liquidity, trade volume, price momentum, screener indicators, and order flow',
    tools: ['dex.screener', 'pool.liquidity', 'market.summary', 'dex.pairs'],
    associatedTools: ['dex.screener', 'pool.liquidity', 'market.summary', 'dex.pairs'],
    fieldsProduced: ['pool.liquidityUsd', 'pool.volume24h', 'pool.priceUsd', 'pool.feeTier'],
    standardFields: ['pool.liquidityUsd', 'pool.volume24h', 'pool.priceUsd', 'pool.feeTier'],
    questionsResolved: ['Does the pool have sufficient depth for trade execution?', 'Is volume real or wash?'],
    estimatedLatencyMs: 250,
    estimatedModelContextTokens: 500,
    providerQuotaCost: 2,
    defaultQuotaUnits: 2,
    monetaryCostUsd: 0.0003,
    defaultMonetaryCostUsd: 0.0003,
    reliability: 0.95,
    freshnessSeconds: 60,
    isOptional: true,
    defaultPriority: 8,
    defaultDecisionImpact: 'HIGH',
    estimatedImpactScore: 0.9,
    probabilityStateChange: 0.7,
    independenceValue: 0.85,
    isMandatoryForGoals: ['TRIAGE', 'DEEP_RESEARCH', 'SKEPTIC'],
  },
  {
    familyId: 'CONTRACT_SECURITY',
    id: 'CONTRACT_SECURITY',
    name: 'Contract Security & Honeypot Audit',
    description: 'Smart contract audit, bytecode analysis, honeypot scan, mint/freeze authorities, and tax rules',
    tools: ['contract.audit', 'risk.honeypot_scan'],
    associatedTools: ['contract.audit', 'risk.honeypot_scan'],
    fieldsProduced: ['audit.isHoneypot', 'audit.mintAuthorityRenounced', 'audit.freezeAuthorityRenounced', 'audit.buyTaxBps', 'audit.sellTaxBps'],
    standardFields: ['audit.isHoneypot', 'audit.mintAuthorityRenounced', 'audit.freezeAuthorityRenounced', 'audit.buyTaxBps', 'audit.sellTaxBps'],
    questionsResolved: ['Can the token be freely traded?', 'Are there malicious admin backdoors?'],
    estimatedLatencyMs: 400,
    estimatedModelContextTokens: 800,
    providerQuotaCost: 3,
    defaultQuotaUnits: 3,
    monetaryCostUsd: 0.0008,
    defaultMonetaryCostUsd: 0.0008,
    reliability: 0.98,
    freshnessSeconds: 86400,
    isOptional: true,
    defaultPriority: 9,
    defaultDecisionImpact: 'HIGH',
    estimatedImpactScore: 0.95,
    probabilityStateChange: 0.8,
    independenceValue: 0.9,
    isMandatoryForGoals: ['SKEPTIC', 'DEEP_RESEARCH'],
  },
  {
    familyId: 'HOLDER_DISTRIBUTION',
    id: 'HOLDER_DISTRIBUTION',
    name: 'Holder Distribution & Centralization',
    description: 'Token holder concentration, top 10/20 whale share, deployer balance, and distribution entropy',
    tools: ['holder.distribution'],
    associatedTools: ['holder.distribution'],
    fieldsProduced: ['holders.totalCount', 'holders.top10Percentage', 'holders.devPercentage', 'holders.concentrationEntropy'],
    standardFields: ['holders.totalCount', 'holders.top10Percentage', 'holders.devPercentage', 'holders.concentrationEntropy'],
    questionsResolved: ['Is token supply dangerously concentrated in insider wallets?'],
    estimatedLatencyMs: 350,
    estimatedModelContextTokens: 600,
    providerQuotaCost: 2,
    defaultQuotaUnits: 2,
    monetaryCostUsd: 0.0005,
    defaultMonetaryCostUsd: 0.0005,
    reliability: 0.94,
    freshnessSeconds: 300,
    isOptional: true,
    defaultPriority: 7,
    defaultDecisionImpact: 'HIGH',
    estimatedImpactScore: 0.85,
    probabilityStateChange: 0.65,
    independenceValue: 0.8,
    isMandatoryForGoals: ['DEEP_RESEARCH', 'SKEPTIC'],
  },
  {
    familyId: 'LIQUIDITY_LOCK',
    id: 'LIQUIDITY_LOCK',
    name: 'Liquidity Lock & Burn Verification',
    description: 'LP token burn, lock receipts, timelock duration, and vesting schedule verification',
    tools: ['liquidity.lock'],
    associatedTools: ['liquidity.lock'],
    fieldsProduced: ['liquidity.lockedPercentage', 'liquidity.lockDurationDays', 'liquidity.lockContractAddress', 'liquidity.isBurned'],
    standardFields: ['liquidity.lockedPercentage', 'liquidity.lockDurationDays', 'liquidity.lockContractAddress', 'liquidity.isBurned'],
    questionsResolved: ['Can the deployer pull initial pool liquidity rug?'],
    estimatedLatencyMs: 300,
    estimatedModelContextTokens: 400,
    providerQuotaCost: 2,
    defaultQuotaUnits: 2,
    monetaryCostUsd: 0.0004,
    defaultMonetaryCostUsd: 0.0004,
    reliability: 0.97,
    freshnessSeconds: 3600,
    isOptional: true,
    defaultPriority: 8,
    defaultDecisionImpact: 'HIGH',
    estimatedImpactScore: 0.8,
    probabilityStateChange: 0.6,
    independenceValue: 0.85,
    isMandatoryForGoals: ['SKEPTIC'],
  },
  {
    familyId: 'TRANSACTION_TRACE',
    id: 'TRANSACTION_TRACE',
    name: 'Onchain Transaction Traces',
    description: 'On-chain transaction trace, deployer funder ancestry, wash-trading graphs, and cohort transfer clustering',
    tools: ['solana.transaction_trace'],
    associatedTools: ['solana.transaction_trace'],
    fieldsProduced: ['trace.deployerFunder', 'trace.clusterCohortId', 'trace.priorScamAffiliation', 'trace.washVolumeRatio'],
    standardFields: ['trace.deployerFunder', 'trace.clusterCohortId', 'trace.priorScamAffiliation', 'trace.washVolumeRatio'],
    questionsResolved: ['Is the deployer connected to known serial scam clusters?'],
    estimatedLatencyMs: 600,
    estimatedModelContextTokens: 1200,
    providerQuotaCost: 5,
    defaultQuotaUnits: 5,
    monetaryCostUsd: 0.0015,
    defaultMonetaryCostUsd: 0.0015,
    reliability: 0.92,
    freshnessSeconds: 86400,
    isOptional: true,
    defaultPriority: 6,
    defaultDecisionImpact: 'MEDIUM',
    estimatedImpactScore: 0.7,
    probabilityStateChange: 0.5,
    independenceValue: 0.75,
    isMandatoryForGoals: ['DEEP_RESEARCH'],
  },
  {
    familyId: 'SELL_SIMULATION',
    id: 'SELL_SIMULATION',
    name: 'Sell Simulation & Execution Parity',
    description: 'Executable sell trade simulation, tax enforcement, adverse slippage curve, and quote parity',
    tools: ['simulation.sell', 'simulation.execution'],
    associatedTools: ['simulation.sell', 'simulation.execution'],
    fieldsProduced: ['simulation.sellSuccess', 'simulation.realizedSlippageBps', 'simulation.effectiveTaxBps', 'simulation.gasUsed'],
    standardFields: ['simulation.sellSuccess', 'simulation.realizedSlippageBps', 'simulation.effectiveTaxBps', 'simulation.gasUsed'],
    questionsResolved: ['Does a simulated sell transaction succeed under current pool liquidity?'],
    estimatedLatencyMs: 500,
    estimatedModelContextTokens: 700,
    providerQuotaCost: 4,
    defaultQuotaUnits: 4,
    monetaryCostUsd: 0.0010,
    defaultMonetaryCostUsd: 0.0010,
    reliability: 0.96,
    freshnessSeconds: 30,
    isOptional: true,
    defaultPriority: 8,
    defaultDecisionImpact: 'HIGH',
    estimatedImpactScore: 0.9,
    probabilityStateChange: 0.75,
    independenceValue: 0.95,
    isMandatoryForGoals: ['DEEP_RESEARCH', 'SKEPTIC'],
  },
  {
    familyId: 'HISTORICAL_ANALOG',
    id: 'HISTORICAL_ANALOG',
    name: 'Historical Analog Similarity',
    description: 'Historical analog similarity search, outcome pattern matching, and regime cohort trajectory',
    tools: ['signal.score'],
    associatedTools: ['signal.score'],
    fieldsProduced: ['analog.similarityScore', 'analog.nearestClusterId', 'analog.expectedWinRate', 'analog.regimeMatch'],
    standardFields: ['analog.similarityScore', 'analog.nearestClusterId', 'analog.expectedWinRate', 'analog.regimeMatch'],
    questionsResolved: ['How have structurally similar setups performed in comparable market regimes?'],
    estimatedLatencyMs: 350,
    estimatedModelContextTokens: 500,
    providerQuotaCost: 2,
    defaultQuotaUnits: 2,
    monetaryCostUsd: 0.0005,
    defaultMonetaryCostUsd: 0.0005,
    reliability: 0.88,
    freshnessSeconds: 7200,
    isOptional: true,
    defaultPriority: 5,
    defaultDecisionImpact: 'MEDIUM',
    estimatedImpactScore: 0.65,
    probabilityStateChange: 0.45,
    independenceValue: 0.7,
    isMandatoryForGoals: [],
  },
  {
    familyId: 'SOCIAL_SENTIMENT',
    id: 'SOCIAL_SENTIMENT',
    name: 'Social Attention & Sentiment',
    description: 'Social attention lead-lag metrics, engagement velocity, and bot activity filtering',
    tools: ['market.summary', 'social.activity', 'community.sentiment'],
    associatedTools: ['market.summary', 'social.activity', 'community.sentiment'],
    fieldsProduced: ['social.mentionVelocity', 'social.uniqueAuthors', 'social.botRatio', 'social.sentimentPolarity'],
    standardFields: ['social.mentionVelocity', 'social.uniqueAuthors', 'social.botRatio', 'social.sentimentPolarity'],
    questionsResolved: ['Is organic social momentum building prior to price discovery?'],
    estimatedLatencyMs: 300,
    estimatedModelContextTokens: 450,
    providerQuotaCost: 2,
    defaultQuotaUnits: 2,
    monetaryCostUsd: 0.0004,
    defaultMonetaryCostUsd: 0.0004,
    reliability: 0.85,
    freshnessSeconds: 300,
    isOptional: true,
    defaultPriority: 4,
    defaultDecisionImpact: 'LOW',
    estimatedImpactScore: 0.4,
    probabilityStateChange: 0.3,
    independenceValue: 0.6,
    isMandatoryForGoals: [],
  },
] as const;

export const EVIDENCE_FAMILIES = DEFAULT_EVIDENCE_FAMILIES;

export class EvidenceFamilyRegistry {
  private readonly families = new Map<string, EvidenceFamilyDefinition>();

  constructor(initialFamilies: readonly EvidenceFamilyDefinition[] = DEFAULT_EVIDENCE_FAMILIES) {
    for (const family of initialFamilies) {
      this.register(family);
    }
  }

  public register(family: EvidenceFamilyDefinition): void {
    const famId = family.familyId ?? family.id;
    const cloned: EvidenceFamilyDefinition = {
      ...family,
      familyId: famId,
      id: famId,
      tools: family.tools ?? family.associatedTools ?? [],
      associatedTools: family.associatedTools ?? family.tools ?? [],
      fieldsProduced: family.fieldsProduced ?? family.standardFields ?? [],
      standardFields: family.standardFields ?? family.fieldsProduced ?? [],
      monetaryCostUsd: family.monetaryCostUsd ?? family.defaultMonetaryCostUsd ?? 0.0001,
      defaultMonetaryCostUsd: family.defaultMonetaryCostUsd ?? family.monetaryCostUsd ?? 0.0001,
      providerQuotaCost: family.providerQuotaCost ?? family.defaultQuotaUnits ?? 1,
      defaultQuotaUnits: family.defaultQuotaUnits ?? family.providerQuotaCost ?? 1,
      reliability: family.reliability ?? 0.95,
      isOptional: family.isOptional ?? true,
    };
    this.families.set(famId, Object.freeze(cloned));
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

  public findByTool(toolName: string): EvidenceFamilyDefinition | undefined {
    return this.list().find((f) => f.tools.includes(toolName) || (f.associatedTools && f.associatedTools.includes(toolName)));
  }

  public findByField(fieldName: string): EvidenceFamilyDefinition | undefined {
    return this.list().find((f) => f.fieldsProduced.includes(fieldName) || (f.standardFields && f.standardFields.includes(fieldName)));
  }

  public getFieldToFamilyMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const fam of this.list()) {
      for (const field of fam.fieldsProduced) {
        map.set(field, fam.familyId);
      }
      for (const tool of fam.tools) {
        map.set(tool, fam.familyId);
      }
    }
    return map;
  }
}
