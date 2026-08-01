export class AgentError extends Error {
  constructor(
    public readonly code: string,
    public readonly primaryMessage?: string,
    public readonly details: string[] = [],
  ) {
    super(primaryMessage ? `${code}:${primaryMessage}` : code);
    this.name = 'AgentError';
  }
}

const MAX_DETAIL_LINES = 8;
const MAX_DETAIL_LINE_LENGTH = 500;
const sensitiveLine =
  /((?:^|[\s,;{([])["']?[A-Za-z0-9_-]*(?:authorization|cookie)[A-Za-z0-9_-]*["']?\s*[:=]\s*).*$/gim;
const sensitiveAssignment =
  /((?:^|[\s,;{([])["']?[A-Za-z0-9_-]*(?:token|password|secret|api[_-]?key|authorization|cookie)[A-Za-z0-9_-]*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gim;

const withoutControlCharacters = (value: string): string =>
  [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || code >= 32;
    })
    .join('');

const sanitize = (value: string): string =>
  withoutControlCharacters(value)
    .replace(sensitiveLine, '$1[REDACTED]')
    .replace(sensitiveAssignment, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .slice(0, MAX_DETAIL_LINE_LENGTH);

const detailLines = (details: string[]): string[] => {
  const values: string[] = [];
  for (const detail of details) {
    const trimmed = detail.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as {
        error?: unknown;
        details?: unknown;
      };
      if (typeof parsed.error === 'string') values.push(parsed.error);
      if (Array.isArray(parsed.details))
        values.push(
          ...parsed.details.filter(
            (item): item is string => typeof item === 'string',
          ),
        );
    } catch {
      values.push(...trimmed.split('\n').filter(Boolean));
    }
  }
  return [...new Set(values.map(sanitize))].slice(0, MAX_DETAIL_LINES);
};

/** @deprecated Compatibility alias for callers of the former ZCode layer. */
export { AgentError as ZCodeError };

export const errorCode = (error: unknown): string =>
  error instanceof AgentError
    ? [
        error.code,
        ...(error.primaryMessage
          ? [
              `${/^(?:pnpm|git|gh|npm)\b/.test(error.primaryMessage) ? 'Command' : 'Message'}: ${sanitize(error.primaryMessage)}`,
            ]
          : []),
        ...detailLines(error.details).map(
          (line, index) => `${index === 0 ? 'Cause' : 'Detail'}: ${line}`,
        ),
      ].join('\n')
    : error instanceof Error
      ? sanitize(error.message)
      : sanitize(String(error));
