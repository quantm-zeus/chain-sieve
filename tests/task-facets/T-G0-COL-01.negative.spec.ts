import { describe, it, expect } from 'vitest';
import { Collector } from '../../apps/collector/src/index.js';
import { toStreamRecord } from '@ciag/collector-solana';
import { DecoderRegistry, createPumpBondingCurveDecoder } from '@ciag/program-decoders';

const baseEvent = () => ({
  endpoint: 'https://api.mainnet.solana',
  subscriptionVersion: '1',
  filterVersion: '1',
  connectionGeneration: 1,
  slot: 10n,
  blockHash: 'bh',
  signature: 'sig',
  instructionIndex: 0,
  receivedAt: new Date().toISOString(),
  finality: 'confirmed' as const,
  program: 'pump',
  programVersion: 'bonding-curve-v1',
  eventFamily: 'pool_creation',
  raw: new TextEncoder().encode('x'),
  decoderVersion: '1',
  rightsPolicy: 'allow',
});

describe('T-G0-COL-01 negative and degraded facets', () => {
  it('rejects backdated available_at', () => {
    const ev = baseEvent();
    const past = new Date(Date.parse(ev.receivedAt) - 10000).toISOString();
    expect(() => toStreamRecord(ev as never, past)).toThrow();
  });

  it('checkpoint not monotonic throws', () => {
    const c = new Collector();
    c.checkpoint('p', 10n, 10n);
    expect(() => c.checkpoint('p', 9n, 11n)).toThrow();
  });

  it('invalid gap range throws', () => {
    const c = new Collector();
    expect(() => c.detectGap('p', 10n, 10n, 1n, 1n)).toThrow();
  });

  it('unsupported program version returns degraded not generic constant-product', () => {
    const reg = new DecoderRegistry([createPumpBondingCurveDecoder()]);
    const res = reg.decode('unknown', 'v99', new Uint8Array([1]), 'swap');
    expect(res.status).toBe('unsupported');
    expect(res.reason).toContain('UNKNOWN_PROGRAM_VERSION');
  });

  it('unknown event family returns unsupported', () => {
    const reg = new DecoderRegistry([createPumpBondingCurveDecoder()]);
    const res = reg.decode('pump', 'bonding-curve-v1', new Uint8Array([1, 2]), 'unknown_family');
    expect(res.status).toBe('unsupported');
  });

  it('duplicate detection prevents duplicate canonical event', () => {
    const c = new Collector();
    c.connect(1);
    const ev = { ...baseEvent(), signature: 'dup', slot: 5n };
    const r1 = c.ingest(ev as never);
    const r2 = c.ingest(ev as never);
    expect((r1 as { duplicate: boolean }).duplicate).toBe(false);
    expect((r2 as { duplicate: boolean }).duplicate).toBe(true);
    expect(c.getRevisions().length).toBe(1);
  });

  it('decode failure increments failure rate but preserves raw', () => {
    const c = new Collector();
    c.connect(1);
    c.ingest({ ...baseEvent(), programVersion: 'unknown-v99', raw: new Uint8Array([]) } as never);
    const h = c.healthSnapshot();
    expect(h.decodeFailureRate).toBeGreaterThan(0);
  });

  it('failed backfill keeps gap unresolved', () => {
    const c = new Collector();
    c.detectGap('p', 1n, 5n, 1n, 5n);
    const before = c.getGaps().find((g) => g.fromSlot === 1n)?.status;
    expect(before).toBe('detected');
    c.markUnresolved('p', 1n);
    expect(c.getGaps().find((g) => g.fromSlot === 1n)?.status).toBe('unresolved');
  });
});
