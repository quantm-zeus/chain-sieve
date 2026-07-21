export type OutcomeState = 'PENDING' | 'MATURE' | 'CENSORED';
export interface Outcome { state: OutcomeState; signalSuccess?: boolean; tradableSuccess?: boolean }

export const matureSyntheticOutcome = (observedAt: string, now: string, maturityMs: number): Outcome => {
  if (Date.parse(now) - Date.parse(observedAt) < maturityMs) return { state: 'PENDING' };
  return { state: 'MATURE', signalSuccess: true, tradableSuccess: false };
};

export const assertOutcomeLabelsDistinct = (signalSuccess: boolean | undefined, tradableSuccess: boolean | undefined): void => { if (signalSuccess === undefined || tradableSuccess === undefined) throw new Error('OUTCOME_LABEL_REQUIRED'); };
