import type {
  DesignBasedEstimate,
  PopulationClaimValidation,
  RandomizedEvidenceProbe,
} from '@ciag/shared-schemas';

export interface SampleObservation {
  candidateId: string;
  stratumId?: string | undefined;
  inclusionProbability: number;
  value: number; // e.g. outcome indicator (1/0), net return, or score
}

export interface DesignEstimateOptions {
  targetQuantity: string;
  observations: readonly SampleObservation[];
  populationSize: number;
  strataSizes?: Record<string, number> | undefined;
  selectiveSampleValues?: readonly number[] | undefined;
}

export interface SelectionBiasOptions {
  selectiveValues: readonly number[];
  designEstimate: DesignBasedEstimate;
}

export interface SelectionBiasResult {
  selectiveSampleMean: number;
  designUnbiasedEstimate: number;
  estimatedBias: number;
  relativeBias: number;
}

export interface PopulationClaimOptions {
  intendedClaimScope: 'FULL_UNIVERSE' | 'OBSERVED_SUBSET_ONLY';
  probes?: readonly RandomizedEvidenceProbe[] | undefined;
  observations?: readonly SampleObservation[] | undefined;
  hasRandomizedProbe: boolean;
  universeCandidateCount: number;
  observedCandidateCount: number;
}

export class DesignBasedEstimators {
  /**
   * Computes the Horvitz-Thompson unbiased estimator for population mean.
   *
   * @formula \hat{\mu}_{HT} = \frac{1}{N} \sum_{i \in S} \frac{y_i}{\pi_i}
   * @requirement FR-AGT-010
   * @requirement AC-243, AC-244
   */
  public static computeHorvitzThompson(options: DesignEstimateOptions): DesignBasedEstimate {
    const { targetQuantity, observations, populationSize, strataSizes } = options;

    if (observations.length === 0 || populationSize <= 0) {
      return {
        estimator: 'HORVITZ_THOMPSON',
        targetQuantity,
        pointEstimate: 0,
        standardError: 0,
        confidenceInterval95: [0, 0],
        sampleSize: 0,
        effectiveSampleSize: 0,
        populationSize,
      };
    }

    let sumWeightedY = 0;
    let sumWeights = 0;
    let sumWeightsSq = 0;

    // Group observations by stratum
    const stratumGroups = new Map<string, SampleObservation[]>();

    for (const obs of observations) {
      const pi_i = Math.max(1e-6, Math.min(1.0, obs.inclusionProbability));
      const w_i = 1 / pi_i;
      sumWeightedY += w_i * obs.value;
      sumWeights += w_i;
      sumWeightsSq += w_i * w_i;

      const sId = obs.stratumId ?? 'DEFAULT';
      if (!stratumGroups.has(sId)) {
        stratumGroups.set(sId, []);
      }
      stratumGroups.get(sId)!.push(obs);
    }

    const pointEstimate = sumWeightedY / populationSize;
    const effectiveSampleSize = sumWeightsSq > 0 ? (sumWeights * sumWeights) / sumWeightsSq : 0;

    // Compute Stratified Horvitz-Thompson Variance
    let totalVariance = 0;
    const stratumBreakdown: NonNullable<DesignBasedEstimate['stratumBreakdown']> = [];

    for (const [stratumId, group] of stratumGroups.entries()) {
      const n_h = group.length;
      const N_h = strataSizes?.[stratumId] ?? (populationSize * n_h) / observations.length;
      const mean_h = group.reduce((sum, g) => sum + g.value, 0) / n_h;

      let var_h = 0;
      if (n_h > 1) {
        const sumSqDiff = group.reduce((sum, g) => sum + Math.pow(g.value - mean_h, 2), 0);
        var_h = sumSqDiff / (n_h - 1);
      }

      const inclusionProb = group[0]!.inclusionProbability;
      const f_h = Math.min(1.0, n_h / Math.max(1, N_h)); // sampling fraction
      const stratumWeight = N_h / populationSize;

      // Stratified variance contribution: (N_h / N)^2 * (1 - f_h) * s_h^2 / n_h
      if (n_h > 0) {
        const stratumVarContribution = Math.pow(stratumWeight, 2) * (1 - f_h) * (var_h / n_h);
        totalVariance += stratumVarContribution;
      }

      stratumBreakdown.push({
        stratumId,
        stratumSize: Math.round(N_h),
        sampleSize: n_h,
        inclusionProbability: inclusionProb,
        stratumMean: mean_h,
        stratumVariance: var_h,
      });
    }

    const standardError = Math.sqrt(Math.max(0, totalVariance));
    const marginOfError = 1.96 * standardError;
    const confidenceInterval95: [number, number] = [
      pointEstimate - marginOfError,
      pointEstimate + marginOfError,
    ];

    let selectionBias: DesignBasedEstimate['selectionBias'];
    if (options.selectiveSampleValues && options.selectiveSampleValues.length > 0) {
      const selectiveMean =
        options.selectiveSampleValues.reduce((a, b) => a + b, 0) / options.selectiveSampleValues.length;
      const bias = selectiveMean - pointEstimate;
      const relBias = Math.abs(pointEstimate) > 1e-6 ? bias / pointEstimate : bias;
      selectionBias = {
        selectiveSampleMean: selectiveMean,
        designUnbiasedEstimate: pointEstimate,
        estimatedBias: bias,
        relativeBias: relBias,
      };
    }

    return {
      estimator: 'HORVITZ_THOMPSON',
      targetQuantity,
      pointEstimate,
      standardError,
      confidenceInterval95,
      sampleSize: observations.length,
      effectiveSampleSize,
      populationSize,
      stratumBreakdown,
      selectionBias,
    };
  }

  /**
   * Computes the Hájek stabilized ratio estimator for population mean.
   *
   * @formula \hat{\mu}_{Hajek} = \frac{\sum w_i y_i}{\sum w_i}
   */
  public static computeHajek(options: DesignEstimateOptions): DesignBasedEstimate {
    const { targetQuantity, observations, populationSize, strataSizes } = options;

    if (observations.length === 0 || populationSize <= 0) {
      return {
        estimator: 'HAJEK',
        targetQuantity,
        pointEstimate: 0,
        standardError: 0,
        confidenceInterval95: [0, 0],
        sampleSize: 0,
        effectiveSampleSize: 0,
        populationSize,
      };
    }

    let sumWeightedY = 0;
    let sumWeights = 0;
    let sumWeightsSq = 0;

    for (const obs of observations) {
      const pi_i = Math.max(1e-6, Math.min(1.0, obs.inclusionProbability));
      const w_i = 1 / pi_i;
      sumWeightedY += w_i * obs.value;
      sumWeights += w_i;
      sumWeightsSq += w_i * w_i;
    }

    const pointEstimate = sumWeights > 0 ? sumWeightedY / sumWeights : 0;
    const effectiveSampleSize = sumWeightsSq > 0 ? (sumWeights * sumWeights) / sumWeightsSq : 0;

    // Hájek variance using residuals e_i = y_i - pointEstimate
    let totalVariance = 0;
    const stratumGroups = new Map<string, SampleObservation[]>();
    for (const obs of observations) {
      const sId = obs.stratumId ?? 'DEFAULT';
      if (!stratumGroups.has(sId)) stratumGroups.set(sId, []);
      stratumGroups.get(sId)!.push(obs);
    }

    const stratumBreakdown: NonNullable<DesignBasedEstimate['stratumBreakdown']> = [];

    for (const [stratumId, group] of stratumGroups.entries()) {
      const n_h = group.length;
      const N_h = strataSizes?.[stratumId] ?? (populationSize * n_h) / observations.length;
      const mean_h = group.reduce((sum, g) => sum + g.value, 0) / n_h;

      let var_h = 0;
      if (n_h > 1) {
        const sumSqDiff = group.reduce((sum, g) => sum + Math.pow(g.value - pointEstimate, 2), 0);
        var_h = sumSqDiff / (n_h - 1);
      }

      const f_h = Math.min(1.0, n_h / Math.max(1, N_h));
      const stratumWeight = N_h / populationSize;

      if (n_h > 0) {
        totalVariance += Math.pow(stratumWeight, 2) * (1 - f_h) * (var_h / n_h);
      }

      stratumBreakdown.push({
        stratumId,
        stratumSize: Math.round(N_h),
        sampleSize: n_h,
        inclusionProbability: group[0]!.inclusionProbability,
        stratumMean: mean_h,
        stratumVariance: var_h,
      });
    }

    const standardError = Math.sqrt(Math.max(0, totalVariance));
    const marginOfError = 1.96 * standardError;
    const confidenceInterval95: [number, number] = [
      pointEstimate - marginOfError,
      pointEstimate + marginOfError,
    ];

    let selectionBias: DesignBasedEstimate['selectionBias'];
    if (options.selectiveSampleValues && options.selectiveSampleValues.length > 0) {
      const selectiveMean =
        options.selectiveSampleValues.reduce((a, b) => a + b, 0) / options.selectiveSampleValues.length;
      const bias = selectiveMean - pointEstimate;
      const relBias = Math.abs(pointEstimate) > 1e-6 ? bias / pointEstimate : bias;
      selectionBias = {
        selectiveSampleMean: selectiveMean,
        designUnbiasedEstimate: pointEstimate,
        estimatedBias: bias,
        relativeBias: relBias,
      };
    }

    return {
      estimator: 'HAJEK',
      targetQuantity,
      pointEstimate,
      standardError,
      confidenceInterval95,
      sampleSize: observations.length,
      effectiveSampleSize,
      populationSize,
      stratumBreakdown,
      selectionBias,
    };
  }

  /**
   * Computes selection bias between selective observations and design-based estimate.
   */
  public static computeSelectionBias(options: SelectionBiasOptions): SelectionBiasResult {
    const { selectiveValues, designEstimate } = options;
    const selectiveMean =
      selectiveValues.length > 0
        ? selectiveValues.reduce((a, b) => a + b, 0) / selectiveValues.length
        : 0;
    const estimatedBias = selectiveMean - designEstimate.pointEstimate;
    const relativeBias =
      Math.abs(designEstimate.pointEstimate) > 1e-6
        ? estimatedBias / designEstimate.pointEstimate
        : estimatedBias;

    return {
      selectiveSampleMean: selectiveMean,
      designUnbiasedEstimate: designEstimate.pointEstimate,
      estimatedBias,
      relativeBias,
    };
  }

  /**
   * Validates whether a population claim (e.g. FULL_UNIVERSE recall or precision) is valid
   * or must be strictly limited to the OBSERVED_SUBSET_ONLY.
   *
   * @requirement AC-244 (Feature learned only from selectively deep-researched candidates cannot claim full-universe lift without valid selection adjustment or explicitly restricted population)
   * @requirement FR-AGT-010, FR-MAT-007, FR-DISC-010
   */
  public static validatePopulationClaim(options: PopulationClaimOptions): PopulationClaimValidation {
    const {
      intendedClaimScope,
      probes,
      observations,
      hasRandomizedProbe,
      universeCandidateCount,
      observedCandidateCount,
    } = options;

    const unsupportedGeneralizations: string[] = [];
    let isRandomizedDesignValid = true;
    let minInclusionProbability = 1.0;
    let maxInclusionProbability = 0.0;
    let zeroInclusionProbabilityCount = 0;

    if (probes && probes.length > 0) {
      for (const p of probes) {
        if (p.inclusionProbability <= 0) {
          zeroInclusionProbabilityCount++;
          isRandomizedDesignValid = false;
        }
        minInclusionProbability = Math.min(minInclusionProbability, p.inclusionProbability);
        maxInclusionProbability = Math.max(maxInclusionProbability, p.inclusionProbability);
      }
    } else if (observations && observations.length > 0) {
      for (const o of observations) {
        if (o.inclusionProbability <= 0) {
          zeroInclusionProbabilityCount++;
          isRandomizedDesignValid = false;
        }
        minInclusionProbability = Math.min(minInclusionProbability, o.inclusionProbability);
        maxInclusionProbability = Math.max(maxInclusionProbability, o.inclusionProbability);
      }
    } else {
      minInclusionProbability = 0;
      maxInclusionProbability = 0;
      isRandomizedDesignValid = false;
    }

    // Check if full universe is claimed without valid randomized design or complete census
    const isCompleteCensus = observedCandidateCount >= universeCandidateCount && universeCandidateCount > 0;
    let claimScope: PopulationClaimValidation['claimScope'] = intendedClaimScope;
    let restrictionReason: string | undefined;

    if (intendedClaimScope === 'FULL_UNIVERSE') {
      if (!isCompleteCensus && !hasRandomizedProbe) {
        claimScope = 'OBSERVED_SUBSET_ONLY';
        isRandomizedDesignValid = false;
        restrictionReason =
          'Full-universe claim prohibited: selective observations without randomized probe allocation cannot generalize beyond observed subset (AC-244).';
        unsupportedGeneralizations.push(
          'Selective deep-research creates unadjusted selection bias; full-universe recall/precision is invalid.',
        );
      } else if (!isCompleteCensus && zeroInclusionProbabilityCount > 0) {
        claimScope = 'OBSERVED_SUBSET_ONLY';
        isRandomizedDesignValid = false;
        restrictionReason =
          'Full-universe claim prohibited: zero inclusion probabilities detected in eligible population.';
        unsupportedGeneralizations.push(
          'Zero inclusion probabilities prevent inverse-probability design estimation for non-sampled strata.',
        );
      } else if (!isCompleteCensus && minInclusionProbability <= 0) {
        claimScope = 'OBSERVED_SUBSET_ONLY';
        isRandomizedDesignValid = false;
        restrictionReason =
          'Full-universe claim prohibited: minimum inclusion probability must be strictly positive (AC-243).';
        unsupportedGeneralizations.push(
          'Missing or zero inclusion probabilities invalidate Horvitz-Thompson estimation.',
        );
      }
    }

    return {
      claimScope,
      isRandomizedDesignValid,
      minInclusionProbability: minInclusionProbability > 1.0 ? 0 : minInclusionProbability,
      maxInclusionProbability,
      zeroInclusionProbabilityCount,
      unsupportedGeneralizations,
      restrictionReason,
      validatedAt: new Date().toISOString(),
    };
  }
}
