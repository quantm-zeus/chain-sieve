/**
 * @requirement FR-AGT-009 - Value-of-information planner persists a decision for every eligible optional evidence family
 * @requirement FR-DATA-011 - Distinct evidence acquisition states
 * @requirement FR-DATA-012 - Structured evidence acquisition records
 */

export interface EvidenceFamilyDefinition {
  id: string;
  name: string;
  description: string;
  associatedTools: readonly string[];
  standardFields: readonly string[];
  defaultMonetaryCostUsd: number;
  defaultQuotaUnits: number;
  defaultDecisionImpact: 'HIGH' | 'MEDIUM' | 'LOW';
  estimatedImpactScore: number; // 0..1
  probabilityStateChange: number; // 0..1
  reliability: number; // 0..1
  independenceValue: number; // 0..1
  isMandatoryForGoals?: readonly string[];
}

export const EVIDENCE_FAMILIES: readonly EvidenceFamilyDefinition[] = [
  {
    id: 'TOKEN_PROFILE',
    name: 'Token Metadata & Profile',
    description: 'Basic token profile, symbols, mint decimals, name, metadata verification',
    associatedTools: ['token.profile'],
    standardFields: ['mint', 'decimals', 'symbol', 'name', 'supply', 'created_at'],
    defaultMonetaryCostUsd: 0.0005,
    defaultQuotaUnits: 1,
    defaultDecisionImpact: 'MEDIUM',
    estimatedImpactScore: 0.6,
    probabilityStateChange: 0.4,
    reliability: 0.95,
    independenceValue: 0.9,
    isMandatoryForGoals: ['TRIAGE', 'DEEP_RESEARCH'],
  },
  {
    id: 'MARKET_LIQUIDITY',
    name: 'Market & Pool Liquidity',
    description: 'DEX pools, usable liquidity, volume, price discovery, and reserve depth',
    associatedTools: ['dex.pairs', 'dex.screener', 'pool.liquidity', 'market.summary'],
    standardFields: ['liquidityUsd', 'volumeUsd24h', 'priceUsd', 'pairAddress', 'reserveBase', 'reserveQuote'],
    defaultMonetaryCostUsd: 0.001,
    defaultQuotaUnits: 1,
    defaultDecisionImpact: 'HIGH',
    estimatedImpactScore: 0.9,
    probabilityStateChange: 0.7,
    reliability: 0.95,
    independenceValue: 0.85,
    isMandatoryForGoals: ['TRIAGE', 'DEEP_RESEARCH', 'SKEPTIC'],
  },
  {
    id: 'HOLDER_DISTRIBUTION',
    name: 'Holder Distribution & Centralization',
    description: 'Top holder concentrations, deployer balance share, and wallet dispersion',
    associatedTools: ['holder.distribution'],
    standardFields: ['topHolders', 'top10Share', 'deployerShare', 'uniqueHoldersCount'],
    defaultMonetaryCostUsd: 0.002,
    defaultQuotaUnits: 2,
    defaultDecisionImpact: 'HIGH',
    estimatedImpactScore: 0.85,
    probabilityStateChange: 0.65,
    reliability: 0.9,
    independenceValue: 0.8,
    isMandatoryForGoals: ['DEEP_RESEARCH', 'SKEPTIC'],
  },
  {
    id: 'CONTRACT_SECURITY',
    name: 'Contract Security & Honeypot Audit',
    description: 'Automated contract bytecode analysis, honeypot detection, mint/freeze authority checks',
    associatedTools: ['contract.audit', 'risk.honeypot_scan'],
    standardFields: ['isHoneypot', 'isMintable', 'isFreezable', 'isProxy', 'auditScore', 'knownVulnerabilities'],
    defaultMonetaryCostUsd: 0.0025,
    defaultQuotaUnits: 2,
    defaultDecisionImpact: 'HIGH',
    estimatedImpactScore: 0.95,
    probabilityStateChange: 0.8,
    reliability: 0.92,
    independenceValue: 0.9,
    isMandatoryForGoals: ['SKEPTIC', 'DEEP_RESEARCH'],
  },
  {
    id: 'LIQUIDITY_LOCK',
    name: 'Liquidity Lock & Burn Verification',
    description: 'LP token lock status, burn percentage, lock contract and unlock schedules',
    associatedTools: ['liquidity.lock'],
    standardFields: ['isLocked', 'lockDurationDays', 'burnedPercentage', 'unlockDate', 'lockContract'],
    defaultMonetaryCostUsd: 0.0015,
    defaultQuotaUnits: 1,
    defaultDecisionImpact: 'HIGH',
    estimatedImpactScore: 0.8,
    probabilityStateChange: 0.6,
    reliability: 0.9,
    independenceValue: 0.85,
    isMandatoryForGoals: ['SKEPTIC'],
  },
  {
    id: 'TRANSACTION_TRACE',
    name: 'Onchain Transaction Traces',
    description: 'Deployer funding source, transaction graphs, insider clustering, and wash trading traces',
    associatedTools: ['solana.transaction_trace'],
    standardFields: ['recentTransfers', 'deployerFundingSource', 'washTradingDetected', 'insiderClustering'],
    defaultMonetaryCostUsd: 0.004,
    defaultQuotaUnits: 3,
    defaultDecisionImpact: 'MEDIUM',
    estimatedImpactScore: 0.7,
    probabilityStateChange: 0.5,
    reliability: 0.85,
    independenceValue: 0.75,
    isMandatoryForGoals: ['DEEP_RESEARCH'],
  },
  {
    id: 'EXECUTION_SIMULATION',
    name: 'Execution & Slippage Simulation',
    description: 'Simulated buy/sell routing, adverse impact, price impact, transfer tax, and tradability verification',
    associatedTools: ['simulation.sell', 'simulation.execution'],
    standardFields: ['simulatedSlippageBps', 'effectivePriceUsd', 'sellFeasible', 'taxBps', 'priceImpactBps'],
    defaultMonetaryCostUsd: 0.003,
    defaultQuotaUnits: 2,
    defaultDecisionImpact: 'HIGH',
    estimatedImpactScore: 0.9,
    probabilityStateChange: 0.75,
    reliability: 0.95,
    independenceValue: 0.95,
    isMandatoryForGoals: ['DEEP_RESEARCH', 'SKEPTIC'],
  },
  {
    id: 'SOCIAL_SENTIMENT',
    name: 'Social Signals & Community Sentiment',
    description: 'Social media velocity, follower engagement, influencer mentions, bot activity ratio',
    associatedTools: ['social.activity', 'community.sentiment'],
    standardFields: ['followerCount', 'engagementRate', 'sentimentScore', 'botActivityRatio'],
    defaultMonetaryCostUsd: 0.005,
    defaultQuotaUnits: 3,
    defaultDecisionImpact: 'LOW',
    estimatedImpactScore: 0.4,
    probabilityStateChange: 0.3,
    reliability: 0.65,
    independenceValue: 0.6,
    isMandatoryForGoals: [],
  },
  {
    id: 'DEVELOPER_ACTIVITY',
    name: 'Developer & Deployer History',
    description: 'Historical deployer wallets, prior rug pulls, repeat token deployment patterns',
    associatedTools: ['developer.history', 'deployer.reputation'],
    standardFields: ['previousLaunchesCount', 'rugPullHistoryCount', 'deployerAgeDays'],
    defaultMonetaryCostUsd: 0.0035,
    defaultQuotaUnits: 2,
    defaultDecisionImpact: 'MEDIUM',
    estimatedImpactScore: 0.65,
    probabilityStateChange: 0.45,
    reliability: 0.8,
    independenceValue: 0.7,
    isMandatoryForGoals: [],
  },
] as const;

export class EvidenceFamilyRegistry {
  private readonly families = new Map<string, EvidenceFamilyDefinition>();

  constructor(initial: readonly EvidenceFamilyDefinition[] = EVIDENCE_FAMILIES) {
    for (const fam of initial) {
      this.families.set(fam.id, fam);
    }
  }

  public get(id: string): EvidenceFamilyDefinition | undefined {
    return this.families.get(id);
  }

  public require(id: string): EvidenceFamilyDefinition {
    const fam = this.families.get(id);
    if (!fam) throw new Error(`UNKNOWN_EVIDENCE_FAMILY:${id}`);
    return fam;
  }

  public list(): EvidenceFamilyDefinition[] {
    return Array.from(this.families.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  public findByTool(toolName: string): EvidenceFamilyDefinition | undefined {
    for (const fam of this.families.values()) {
      if (fam.associatedTools.includes(toolName)) return fam;
    }
    return undefined;
  }
}
