import { timingSafeEqual } from 'node:crypto';
import { requireReadOnlyCapability } from './negative-capability.js';

export interface McpSessionScope {
  sessionId: string;
  clientId: string;
  allowedTools?: readonly string[];
  expiresAt?: string;
  roles?: readonly string[];
  metadata?: Record<string, unknown>;
}

export const SUPPORTED_MCP_PROTOCOLS = Object.freeze(['2025-11-25']);

export const validateMcpProtocol = (
  protocolVersion: string | undefined,
  supportedVersions: readonly string[] = SUPPORTED_MCP_PROTOCOLS,
): void => {
  if (protocolVersion !== undefined && !supportedVersions.includes(protocolVersion)) {
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
  if (!expectedToken) return;

  if (!authHeader) {
    throw new Error('UNAUTHORIZED');
  }

  const expected = Buffer.from(`Bearer ${expectedToken}`);
  const supplied = Buffer.from(authHeader);

  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
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
  if (!session.sessionId || typeof session.sessionId !== 'string') {
    throw new Error('INVALID_SESSION_ID');
  }

  if (!session.clientId || typeof session.clientId !== 'string' || session.clientId.length > 128) {
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
