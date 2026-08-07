import { describe, expect, it } from 'vitest';
import { providerFromLaunchReceiptId } from '../../tools/agent/lib/executor.js';

describe('launch receipt provider resolution', () => {
  it('preserves every registered autonomous provider identity', () => {
    expect(providerFromLaunchReceiptId('antigravity-abc')).toBe('antigravity');
    expect(providerFromLaunchReceiptId('claude-deepseek-abc')).toBe(
      'claude-deepseek',
    );
    expect(providerFromLaunchReceiptId('codex-abc')).toBe('codex');
    expect(providerFromLaunchReceiptId('muse-abc')).toBe('muse');
    expect(providerFromLaunchReceiptId('zcode-abc')).toBe('zcode');
  });

  it('fails closed for an unknown receipt prefix', () => {
    expect(() => providerFromLaunchReceiptId('unknown-abc')).toThrow(
      'UNKNOWN_LAUNCH_RECEIPT_PROVIDER',
    );
  });
});
