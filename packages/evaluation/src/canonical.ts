import { createHash } from 'node:crypto';

export const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export const isValidIso = (s: string): boolean => {
  if (!ISO_DATETIME_RE.test(s)) return false;
  const ms = Date.parse(s);
  return !Number.isNaN(ms);
};

export const sha256Hex = (data: string): string =>
  createHash('sha256').update(data, 'utf8').digest('hex');

export const canonicalize = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const result: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    const val = obj[k];
    if (val !== undefined) {
      result[k] = canonicalize(val);
    }
  }
  return result;
};
