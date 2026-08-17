/**
 * @requirement AC-042 - Baseline and champion use the same frozen candidate universe and data cutoff.
 *
 * Implements immutable frozen candidate universes and validation logic to prevent evaluation bias.
 */

import { EvaluationError } from './errors.js';
import type { FrozenCandidateUniverse } from './types.js';
import { canonicalize, ISO_DATETIME_RE, isValidIso, sha256Hex } from './canonical.js';

const SHA256_RE = /^[a-f0-9]{64}$/;


export interface CreateUniverseInput {
  universeId: string;
  dataCutoff: string;
  candidateAssetIds: string[];
  corpusVersion?: string | undefined;
}

/**
 * Create an immutable FrozenCandidateUniverse.
 */
export const createFrozenCandidateUniverse = (input: CreateUniverseInput): FrozenCandidateUniverse => {
  if (!input || typeof input !== 'object') {
    throw new EvaluationError('EVAL_MALFORMED', 'UNIVERSE_INPUT_REQUIRED');
  }
  if (!input.universeId || typeof input.universeId !== 'string') {
    throw new EvaluationError('EVAL_MALFORMED', 'UNIVERSE_ID_REQUIRED');
  }
  if (!input.dataCutoff || !isValidIso(input.dataCutoff)) {
    throw new EvaluationError('EVAL_MALFORMED', 'DATA_CUTOFF_INVALID_ISO');
  }
  if (!Array.isArray(input.candidateAssetIds) || input.candidateAssetIds.length === 0) {
    throw new EvaluationError('EVAL_INCOMPLETE', 'CANDIDATE_ASSET_IDS_EMPTY');
  }

  // Deduplicate and sort lexicographically for deterministic stability
  const sortedAssetIds = Array.from(new Set(input.candidateAssetIds)).sort();
  const corpusVersion = input.corpusVersion ?? '1.0.0';

  const canonicalPayload = {
    universeId: input.universeId,
    dataCutoff: input.dataCutoff,
    candidateAssetIds: sortedAssetIds,
    totalAssets: sortedAssetIds.length,
    corpusVersion,
  };

  const canonicalJson = JSON.stringify(canonicalize(canonicalPayload));
  const sha256 = sha256Hex(canonicalJson);

  return Object.freeze({
    universeId: input.universeId,
    dataCutoff: input.dataCutoff,
    candidateAssetIds: sortedAssetIds,
    totalAssets: sortedAssetIds.length,
    corpusVersion,
    sha256,
  }) as FrozenCandidateUniverse;
};

/**
 * Validate that a frozen candidate universe is structurally sound.
 */
export const validateFrozenUniverse = (universe: FrozenCandidateUniverse): void => {
  if (!universe || typeof universe !== 'object') {
    throw new EvaluationError('EVAL_MALFORMED', 'FROZEN_UNIVERSE_REQUIRED');
  }
  if (!universe.universeId || typeof universe.universeId !== 'string') {
    throw new EvaluationError('EVAL_MALFORMED', 'UNIVERSE_ID_REQUIRED');
  }
  if (!universe.dataCutoff || !isValidIso(universe.dataCutoff)) {
    throw new EvaluationError('EVAL_MALFORMED', 'DATA_CUTOFF_INVALID');
  }
  if (!Array.isArray(universe.candidateAssetIds) || universe.candidateAssetIds.length === 0) {
    throw new EvaluationError('EVAL_INCOMPLETE', 'CANDIDATE_ASSET_IDS_EMPTY');
  }
  if (!universe.sha256 || !SHA256_RE.test(universe.sha256)) {
    throw new EvaluationError('EVAL_MALFORMED', 'UNIVERSE_HASH_MALFORMED');
  }

  // Re-verify hash integrity
  const canonicalPayload = {
    universeId: universe.universeId,
    dataCutoff: universe.dataCutoff,
    candidateAssetIds: universe.candidateAssetIds,
    totalAssets: universe.totalAssets,
    corpusVersion: universe.corpusVersion,
  };
  const expectedHash = sha256Hex(JSON.stringify(canonicalize(canonicalPayload)));
  if (expectedHash !== universe.sha256) {
    throw new EvaluationError('EVAL_INCONSISTENT', 'UNIVERSE_HASH_MISMATCH');
  }
};

/**
 * Assert that two candidate universes and cutoffs are identical (AC-042).
 * Fails closed if baseline and champion are evaluated against different universes or cutoffs.
 */
export const assertIdenticalUniverses = (
  u1: FrozenCandidateUniverse,
  u2: FrozenCandidateUniverse,
): void => {
  validateFrozenUniverse(u1);
  validateFrozenUniverse(u2);

  if (u1.dataCutoff !== u2.dataCutoff) {
    throw new EvaluationError(
      'EVAL_DATA_CUTOFF_MISMATCH',
      `Data cutoff mismatch between policies: ${u1.dataCutoff} vs ${u2.dataCutoff}`,
    );
  }

  if (u1.sha256 !== u2.sha256) {
    throw new EvaluationError(
      'EVAL_UNIVERSE_MISMATCH',
      `Candidate universe hash mismatch between policies: ${u1.sha256} vs ${u2.sha256}`,
    );
  }
};
