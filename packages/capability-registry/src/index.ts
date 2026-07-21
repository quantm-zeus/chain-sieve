import type { CapabilityState } from '@ciag/domain';

export interface CapabilityRecord { id: string; engineeringState: CapabilityState; availabilityState: CapabilityState; influenceState: CapabilityState; reason: string }

export class CapabilityRegistry {
  private readonly records = new Map<string, CapabilityRecord>();
  register(record: CapabilityRecord): void { this.records.set(record.id, structuredClone(record)); }
  get(id: string): CapabilityRecord | undefined { const value = this.records.get(id); return value ? structuredClone(value) : undefined; }
  activate(): never { throw new Error('AUTOMATIC_CAPABILITY_ACTIVATION_PROHIBITED'); }
  list(): CapabilityRecord[] { return [...this.records.values()].map((record) => structuredClone(record)); }
}
