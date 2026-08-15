/**
 * Origin validation and normalization for MCP and HTTP endpoints.
 * Enforces strict scheme-host-port allowlists and fails closed.
 */

export const normalizeOrigin = (origin: string): string => {
  if (typeof origin !== 'string' || origin.trim() === '') {
    throw new Error('MCP_ORIGIN_REQUIRED');
  }

  const trimmed = origin.trim();
  if (trimmed === 'null' || trimmed.includes('\n') || trimmed.includes('\r') || trimmed.includes('\0')) {
    throw new Error('MCP_ORIGIN_MALFORMED');
  }

  try {
    const url = new URL(trimmed);
    const protocol = url.protocol.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw new Error('MCP_ORIGIN_MALFORMED');
    }

    if (url.username || url.password) {
      throw new Error('MCP_ORIGIN_MALFORMED');
    }

    const host = url.hostname.toLowerCase();
    if (!host || host.includes(' ')) {
      throw new Error('MCP_ORIGIN_MALFORMED');
    }

    if (host.includes(':') && !trimmed.includes('[')) {
      throw new Error('MCP_ORIGIN_MALFORMED');
    }

    const formattedHost = host.includes(':')
      ? `[${host.replace(/^\[|\]$/g, '')}]`
      : host;

    let port = url.port;
    if ((protocol === 'http:' && port === '80') || (protocol === 'https:' && port === '443')) {
      port = '';
    }

    return `${protocol}//${formattedHost}${port ? `:${port}` : ''}`;
  } catch (error) {
    if (error instanceof Error && error.message === 'MCP_ORIGIN_MALFORMED') {
      throw error;
    }
    throw new Error('MCP_ORIGIN_MALFORMED');
  }
};

export const validateOrigin = (origin: string | undefined, allowedOrigins: readonly string[]): void => {
  if (origin === undefined || origin === null || origin.trim() === '') {
    throw new Error('MCP_ORIGIN_REQUIRED');
  }

  let normalizedOrigin: string;
  try {
    normalizedOrigin = normalizeOrigin(origin);
  } catch {
    throw new Error('MCP_ORIGIN_FORBIDDEN');
  }

  const normalizedAllowed = allowedOrigins.map((allowed) => {
    try {
      return normalizeOrigin(allowed);
    } catch {
      throw new Error('MCP_ORIGIN_MALFORMED');
    }
  });

  if (!normalizedAllowed.includes(normalizedOrigin)) {
    throw new Error('MCP_ORIGIN_FORBIDDEN');
  }
};
