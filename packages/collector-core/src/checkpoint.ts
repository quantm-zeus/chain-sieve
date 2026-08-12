import type { Checkpoint, Gap } from './types.js';

export const isMonotonicCheckpoint = (previous: Checkpoint | undefined, next: Checkpoint): boolean => {
  if (!previous) return true;
  if (previous.partition !== next.partition) return true;
  if (next.slot < previous.slot) return false;
  if (next.slot === previous.slot && next.sequence <= previous.sequence) return false;
  return true;
};

export class CheckpointStore {
  private checkpoints = new Map<string, Checkpoint>();
  private gaps: Gap[] = [];

  commit(checkpoint: Checkpoint): Checkpoint {
    const previous = this.checkpoints.get(checkpoint.partition);
    if (!isMonotonicCheckpoint(previous, checkpoint)) {
      throw new Error(`CHECKPOINT_REGRESSION:${checkpoint.partition}:${previous?.slot}:${checkpoint.slot}`);
    }
    this.checkpoints.set(checkpoint.partition, { ...checkpoint });
    return checkpoint;
  }

  load(partition: string): Checkpoint | undefined {
    const value = this.checkpoints.get(partition);
    return value ? { ...value } : undefined;
  }

  detectGap(partition: string, lastSlot: number, currentSlot: number): Gap | undefined {
    if (currentSlot <= lastSlot + 1) return undefined;
    const gap: Gap = {
      partition,
      fromSlot: lastSlot + 1,
      toSlot: currentSlot - 1,
      detectedAt: new Date().toISOString(),
      resolved: false,
    };
    this.gaps.push(gap);
    return { ...gap };
  }

  listGaps(): Gap[] {
    return this.gaps.map((gap) => ({ ...gap }));
  }

  markGapResolved(partition: string, fromSlot: number): void {
    for (const gap of this.gaps) {
      if (gap.partition === partition && gap.fromSlot === fromSlot) gap.resolved = true;
    }
  }
}
