import { createHash, timingSafeEqual } from 'node:crypto';
import { requireReadOnlyCapability } from './negative-capability.js';

export interface McpSessionScope {
  sessionId: string;
  clientId: string;
  allowedTools?: readonly string[] | undefined;
  expiresAt?: string | undefined;
  roles?: readonly string[] | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export const SUPPORTED_MCP_PROTOCOLS = Object.freeze(['2025-11-25']);

export const validateMcpProtocol = (
  protocolVersion: string | undefined,
  supportedVersions: readonly string[] = SUPPORTED_MCP_PROTOCOLS,
  options?: { allowMissing?: boolean | undefined },
): void => {
  if (protocolVersion === undefined) {
    if (options?.allowMissing === true) {
      return;
    }
    throw new Error('UNSUPPORTED_PROTOCOL_VERSION');
  }
  if (!supportedVersions.includes(protocolVersion)) {
    throw new Error('UNSUPPORTED_PROTOCOL_VERSION');
  }
};

export const validateMcpContentType = (contentType: string | undefined): void => {
  if (!contentType) {
    throw new Error('UNSUPPORTED_MEDIA_TYPE');
  }
  const normalized = contentType.toLowerCase().split(';')[0]?.trim();
  if (normalized !== 'application/json') {
    throw new Error('UNSUPPORTED_MEDIA_TYPE');
  }
};

export const validateBearerAuth = (
  authHeader: string | undefined,
  expectedToken: string | undefined,
): void => {
  if (!expectedToken || typeof expectedToken !== 'string' || expectedToken.trim() === '') {
    throw new Error('UNAUTHORIZED');
  }

  if (!authHeader || typeof authHeader !== 'string') {
    throw new Error('UNAUTHORIZED');
  }

  const expectedHash = createHash('sha256').update(`Bearer ${expectedToken}`).digest();
  const suppliedHash = createHash('sha256').update(authHeader).digest();

  if (!timingSafeEqual(expectedHash, suppliedHash)) {
    throw new Error('UNAUTHORIZED');
  }
};

export const validateToolAllowlist = (
  toolName: string,
  allowlist: readonly string[],
): void => {
  requireReadOnlyCapability(toolName);
  if (!allowlist.includes(toolName)) {
    throw new Error('TOOL_ACCESS_FORBIDDEN');
  }
};

export const validateMcpSessionScope = (
  session: McpSessionScope,
  requestedTool: string,
): void => {
  if (!session.sessionId || typeof session.sessionId !== 'string' || session.sessionId.trim() === '') {
    throw new Error('INVALID_SESSION_ID');
  }

  if (!session.clientId || typeof session.clientId !== 'string' || session.clientId.trim() === '' || session.clientId.length > 128) {
    throw new Error('INVALID_CLIENT_ID');
  }

  if (session.expiresAt) {
    const expiryMs = Date.parse(session.expiresAt);
    if (Number.isNaN(expiryMs) || expiryMs <= Date.now()) {
      throw new Error('SESSION_EXPIRED');
    }
  }

  requireReadOnlyCapability(requestedTool);

  if (session.allowedTools !== undefined) {
    if (!session.allowedTools.includes(requestedTool)) {
      throw new Error('TOOL_ACCESS_FORBIDDEN');
    }
  }
};
