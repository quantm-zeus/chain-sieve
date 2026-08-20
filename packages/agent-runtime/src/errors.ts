export type BudgetDimension =
  | 'STEPS'
  | 'TOOL_CALLS'
  | 'TOOL_CALLS_PER_CANDIDATE'
  | 'PROVIDER_CALLS'
  | 'INPUT_TOKENS'
  | 'OUTPUT_TOKENS'
  | 'MODEL_COST_USD'
  | 'PROVIDER_COST_UNITS'
  | 'DEADLINE';

export class AgentRuntimeError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'AgentRuntimeError';
  }
}

export class UnknownModelProfileError extends AgentRuntimeError {
  constructor(
    public readonly profileId: string,
    public readonly version?: string,
  ) {
    super(
      `Unknown model profile: "${profileId}"${version ? ` version "${version}"` : ''}`,
      'UNKNOWN_MODEL_PROFILE',
    );
    this.name = 'UnknownModelProfileError';
  }
}

export class BudgetExceededError extends AgentRuntimeError {
  constructor(
    public readonly dimension: BudgetDimension,
    public readonly current: number,
    public readonly limit: number,
    public readonly requested: number = 1,
  ) {
    super(
      `Agent budget exceeded on dimension "${dimension}": limit=${limit}, current=${current}, requested=${requested}`,
      'BUDGET_EXCEEDED',
    );
    this.name = 'BudgetExceededError';
  }
}

export type ConfinementViolationType =
  | 'TOOL_NOT_ALLOWED'
  | 'PROVIDER_NOT_ALLOWED'
  | 'URL_NOT_ALLOWED'
  | 'CHAIN_NOT_ALLOWED'
  | 'ADDRESS_NOT_ALLOWED'
  | 'TIME_RANGE_NOT_ALLOWED'
  | 'OUTPUT_SIZE_NOT_ALLOWED'
  | 'COST_NOT_ALLOWED';

export class ConfinementViolationError extends AgentRuntimeError {
  constructor(
    public readonly violationType: ConfinementViolationType,
    public readonly detail: string,
    public readonly toolName: string,
    public readonly attemptedArguments?: Record<string, unknown>,
  ) {
    super(
      `Tool argument confinement violation (${violationType}) for tool "${toolName}": ${detail}`,
      `ENVELOPE_${violationType}`,
    );
    this.name = 'ConfinementViolationError';
  }
}

export class AgentCancelledError extends AgentRuntimeError {
  constructor(message = 'Agent execution was cancelled') {
    super(message, 'AGENT_CANCELLED');
    this.name = 'AgentCancelledError';
  }
}

export class MaxStepsExceededError extends AgentRuntimeError {
  constructor(
    public readonly maxSteps: number,
    public readonly executedSteps: number,
  ) {
    super(
      `Agent reached maximum allowed steps limit (${maxSteps})`,
      'MAX_STEPS_EXCEEDED',
    );
    this.name = 'MaxStepsExceededError';
  }
}
