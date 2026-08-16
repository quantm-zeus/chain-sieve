/**
 * Permanent read-only negative capability enforcement.
 * Structurally forbids transaction construction, signing, submission,
 * custody, swaps, and private key operations across the codebase and runtime.
 */

export const PROHIBITED_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bprivate[_-]?key\b/i,
  /\bseed[_-]?phrase\b/i,
  /\bmnemonic\b/i,
  /\b(?:sign|signed|signing)\b/i,
  /\b(?:sign|signed|signing)[A-Z_0-9][a-zA-Z0-9_]*/,
  /\b(?:SIGN|SIGNED|SIGNING)[_A-Z0-9][a-zA-Z0-9_]*/,
  /\b(?:sign|signed|signing)(?:transaction|payload|message|order|data|rawtx|andsend)\b/i,
  /\b(?:send|submit|broadcast)(?:Raw)?(?:Transaction|SignedPayload)?\b/i,
  /\b(?:swap|createSwap|executeSwap|swapExactIn|swapExactTokensForTokens)\b/i,
  /\b(?:create|cancel|place|fill|submit|execute|limit|market)Order\b/i,
  /\b(?:orderBook|limitOrder|marketOrder|placeOrder)\b/i,
  /\b(?:approve|approveToken|tokenApproval|setApprovalForAll|increaseAllowance|decreaseAllowance)\b/i,
  /\bwalletCustody\b/i,
  /\bbridgeAssets?\b/i,
  /\bstakeTokens?\b/i,
  /\btransferFunds?\b/i,
  /\bwithdrawFunds?\b/i,
]);

export const PROHIBITED_ENV_PATTERNS: readonly RegExp[] = Object.freeze([
  /(?:^|_)PRIVATE_KEY(?:$|_)/i,
  /(?:^|_)WALLET_SECRET(?:$|_)/i,
  /(?:^|_)SECRET_KEY(?:$|_)/i,
  /(?:^|_)SEED_PHRASE(?:$|_)/i,
  /(?:^|_)MNEMONIC(?:$|_)/i,
  /(?:^|_)TRADE_API_KEY(?:$|_)/i,
  /(?:^|_)EXECUTION_KEY(?:$|_)/i,
]);

export const requireReadOnlyCapability = (capability: string): void => {
  if (typeof capability !== 'string') return;
  for (const pattern of PROHIBITED_PATTERNS) {
    if (pattern.test(capability)) {
      throw new Error('PROHIBITED_CAPABILITY');
    }
  }
};

export const assertReadOnlyEnvironment = (
  env: Record<string, string | undefined> = process.env,
): void => {
  for (const key of Object.keys(env)) {
    for (const pattern of PROHIBITED_ENV_PATTERNS) {
      if (pattern.test(key)) {
        throw new Error(`PROHIBITED_SECRET_DETECTED:${key}`);
      }
    }
  }
};

export const scanObjectForProhibitedCapabilities = (
  target: unknown,
  currentPath = '',
  visited = new Set<unknown>(),
): string[] => {
  if (target === null || target === undefined) return [];
  if (typeof target === 'function') {
    const fnName = target.name || '';
    for (const pattern of PROHIBITED_PATTERNS) {
      if (pattern.test(fnName)) {
        return [`${currentPath || 'function'}:${fnName}`];
      }
    }
    return [];
  }
  if (typeof target === 'string') {
    for (const pattern of PROHIBITED_PATTERNS) {
      if (pattern.test(target)) {
        return [`${currentPath}:${target}`];
      }
    }
    return [];
  }
  if (typeof target !== 'object') return [];

  if (visited.has(target)) return [];
  visited.add(target);

  const violations: string[] = [];

  if (Array.isArray(target)) {
    target.forEach((item, index) => {
      violations.push(
        ...scanObjectForProhibitedCapabilities(item, `${currentPath}[${index}]`, visited),
      );
    });
    return violations;
  }

  for (const [key, value] of Object.entries(target as Record<string, unknown>)) {
    const propertyPath = currentPath ? `${currentPath}.${key}` : key;
    for (const pattern of PROHIBITED_PATTERNS) {
      if (pattern.test(key)) {
        violations.push(`${propertyPath}:key`);
      }
    }
    violations.push(
      ...scanObjectForProhibitedCapabilities(value, propertyPath, visited),
    );
  }

  return violations;
};

export const assertReadOnlyExecution = (
  operation: string,
  parameters?: Record<string, unknown>,
): void => {
  requireReadOnlyCapability(operation);
  if (parameters) {
    const violations = scanObjectForProhibitedCapabilities(parameters);
    if (violations.length > 0) {
      throw new Error(`PROHIBITED_CAPABILITY:${violations.join(',')}`);
    }
  }
};
