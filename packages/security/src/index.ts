export const validateOrigin = (origin: string | undefined, allowedOrigins: readonly string[]): void => {
  if (origin === undefined) throw new Error('MCP_ORIGIN_REQUIRED');
  if (!allowedOrigins.includes(origin)) throw new Error('MCP_ORIGIN_FORBIDDEN');
};

export const requireReadOnlyCapability = (capability: string): void => {
  const denied = /(?:sign|submit|swap|approve|order|custody|private[_-]?key|seed|mnemonic)/i;
  if (denied.test(capability)) throw new Error('PROHIBITED_CAPABILITY');
};
