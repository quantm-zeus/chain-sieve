import { describe, expect, it } from 'vitest';
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from '../../tools/agent/lib/types.js';
import {
  deterministicRecoveryDiagnosis,
  recoveryLanesForAction,
  verifyGeneratedRecoveryNoop,
} from '../../tools/product-factory/recovery-supervisor.js';
import { pathMatchesLane } from '../../tools/product-factory/recovery-contract.js';

const ok = (stdout = ''): CommandResult => ({ status: 0, stdout, stderr: '' });

class NoopRunner implements CommandRunner {
  readonly calls: string[] = [];

  constructor(private readonly driftFailure?: string) {}

  run(command: string, args: string[], _options?: CommandOptions): CommandResult {
    const call = `${command} ${args.join(' ')}`;
    this.calls.push(call);
    if (
      this.driftFailure &&
      command === 'pnpm' &&
      args.join(' ') === '--silent prd:drift-check'
    ) {
      return { status: 1, stdout: '', stderr: this.driftFailure };
    }
    return ok();
  }
}

describe('deterministic generated-contract recovery', () => {
  it('selects compiler reconciliation without a semantic diagnosis and preserves failure evidence', () => {
    const failure = [
      'GENERATED_CONTRACT_DRIFT',
      'Command: pnpm prd:drift-check',
      'Cause: GENERATED_DRIFT:tasks/G0/T-G0-COL-01.contract.json,artifacts/context/T-G0-COL-01/context-manifest.json',
    ].join('\n');

    const diagnosis = deterministicRecoveryDiagnosis(failure);
    expect(diagnosis).toMatchObject({
      action: 'REGENERATE_DERIVED_TASKS',
      target: 'generated-contracts',
      allowedLanes: ['GENERATED_CONTRACT'],
    });
    expect(diagnosis?.evidence).toContain(
      'Cause: GENERATED_DRIFT:tasks/G0/T-G0-COL-01.contract.json,artifacts/context/T-G0-COL-01/context-manifest.json',
    );
    expect(
      deterministicRecoveryDiagnosis('AUTOPILOT_CORRECTION_LIMIT:T-G0-COL-01:2'),
    ).toBeUndefined();
  });

  it('accepts zero-diff regeneration only after both deterministic guards pass', () => {
    const runner = new NoopRunner();
    expect(
      verifyGeneratedRecoveryNoop(
        runner,
        '/tmp/recovery-worktree',
        'REGENERATE_DERIVED_TASKS',
        [],
      ),
    ).toBe(true);
    expect(runner.calls).toEqual([
      'pnpm --silent spec:verify',
      'pnpm --silent prd:drift-check',
    ]);
  });

  it('does not silently accept zero-change semantic repair', () => {
    const runner = new NoopRunner();
    expect(verifyGeneratedRecoveryNoop(runner, '/tmp/recovery-worktree', 'REPAIR', [])).toBe(
      false,
    );
    expect(runner.calls).toEqual([]);
  });

  it('fails closed when zero-diff regeneration still has deterministic drift', () => {
    const runner = new NoopRunner(
      'GENERATED_DRIFT:tasks/G0/T-G0-COL-01.contract.json',
    );
    expect(() =>
      verifyGeneratedRecoveryNoop(
        runner,
        '/tmp/recovery-worktree',
        'REGENERATE_DERIVED_TASKS',
        [],
      ),
    ).toThrow('PRODUCT_FACTORY_SUPERVISOR_CHECK_FAILED:prd:drift-check');
  });

  it('separates mutable specification source from compiler-owned generated surfaces', () => {
    for (const path of [
      'tasks/G0/T-G0-COL-01.contract.json',
      'clusters/G0/C-G0-IMPLEMENTATION.contract.json',
      'artifacts/context/T-G0-COL-01/context-manifest.json',
      'artifacts/spec/acceptance-partition.json',
      'artifacts/conformance/T-G0-COL-01/manifest.json',
      'docs/schemas/task-contract.schema.json',
    ]) {
      expect(pathMatchesLane(path, 'GENERATED_CONTRACT')).toBe(true);
    }
    expect(pathMatchesLane('docs/spec/PRD.md', 'GENERATED_CONTRACT')).toBe(false);
    expect(pathMatchesLane('docs/adr/ADR-001.md', 'GENERATED_CONTRACT')).toBe(false);
    expect(pathMatchesLane('tools/product-factory/recovery-supervisor.ts', 'GENERATED_CONTRACT')).toBe(
      false,
    );
  });

  it('keeps regeneration generated-only while replan recompiles generated outputs', () => {
    expect(
      recoveryLanesForAction('REGENERATE_DERIVED_TASKS', [
        'SPECIFICATION',
        'GENERATED_CONTRACT',
      ]),
    ).toEqual(['GENERATED_CONTRACT']);
    expect(recoveryLanesForAction('REPLAN', ['SPECIFICATION'])).toEqual([
      'SPECIFICATION',
      'GENERATED_CONTRACT',
    ]);
    expect(recoveryLanesForAction('SPLIT_TASK', ['SPECIFICATION'])).toEqual([
      'SPECIFICATION',
      'GENERATED_CONTRACT',
    ]);
  });
});
