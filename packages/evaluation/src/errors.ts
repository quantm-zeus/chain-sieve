/**
 * @requirement FR-EVAL-019 - Strict artifact class separation.
 * @requirement AC-040 - Outcome profile evaluation errors.
 * @requirement AC-042 - Candidate universe and cutoff consistency.
 *
 * Typed error definitions for the evaluation plane.
 */

export type EvaluationErrorCode =
  | 'EVAL_MALFORMED'
  | 'EVAL_INCOMPLETE'
  | 'EVAL_INCONSISTENT'
  | 'EVAL_CLASS_BLENDED'
  | 'EVAL_UNIVERSE_MISMATCH'
  | 'EVAL_DATA_CUTOFF_MISMATCH'
  | 'EVAL_CHRONOLOGY_VIOLATION'
  | 'OUTCOME_LABEL_REQUIRED';

export class EvaluationError extends Error {
  constructor(
    public readonly code: EvaluationErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'EvaluationError';
  }
}
