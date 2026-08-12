/**
 * @requirement FR-COL-003
 * @requirement FR-COL-004
 * Deterministic bounded reconnection and checkpoint logic (core).
 */
export type BackfillStatus = 'idle' | 'running' | 'unresolved';
export interface BackfillOperation {
  gapId: string;
  bounded: boolean;
  maxSlots: number;
  status: BackfillStatus;
  retrievedAt: string | null;
}
export const createBackfill = (gapId: string, maxSlots = 500): BackfillOperation => ({
  gapId, bounded: true, maxSlots, status: 'idle', retrievedAt: null,
});
export const markUnresolved = (op: BackfillOperation): BackfillOperation => ({ ...op, status: 'unresolved' });
export const completeBackfill = (op: BackfillOperation, retrievedAt: string): BackfillOperation => ({ ...op, status: 'idle', retrievedAt });
