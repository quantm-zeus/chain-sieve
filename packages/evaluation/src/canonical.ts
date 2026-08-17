import { createHash } from 'node:crypto';

export const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export const isValidIso = (s: string): boolean => {
  if (!ISO_DATETIME_RE.test(s)) return false;
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return false;
  const d = new Date(ms);
  // Verify date-time prefix to prevent calendar day rollover (e.g. Feb 30 -> Mar 2)
  if (d.toISOString().slice(0, 19) !== s.slice(0, 19)) return false;
  // If fractional seconds are present, verify millisecond precision prefix matches
  const dotIndex = s.indexOf('.');
  if (dotIndex !== -1) {
    const frac = s.slice(dotIndex + 1, -1);
    const expectedMillis = frac.slice(0, 3).padEnd(3, '0');
    if (d.getUTCMilliseconds().toString().padStart(3, '0') !== expectedMillis) return false;
  } else {
    if (d.getUTCMilliseconds() !== 0) return false;
  }
  return true;
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
