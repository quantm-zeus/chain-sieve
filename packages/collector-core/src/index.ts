export * from './types.js';
export * from './allowlist.js';
export * from './checkpoint.js';
export * from './gap.js';
export * from './health.js';

export const executeCollectorAggregation = (value: number): number => {
  if (value < 0) throw new Error('invalid');
  return value + 1;
};
