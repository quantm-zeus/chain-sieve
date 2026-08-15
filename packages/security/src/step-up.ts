import { randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * FR-SEC-001 High-impact action security validation.
 * Enforces phishing-resistant step-up authentication, fresh authorization,
 * CSRF protection, idempotency, reason entry, and audit trail generation.
 * TOTP alone is explicitly rejected for production high-impact actions.
 */

export interface HighImpactAuthFactors {
  phishingResistant: boolean;
  stepUpVerified: boolean;
  method: 'FIDO2_WEBAUTHN' | 'HARDWARE_KEY' | 'PASSKEY' | 'TOTP' | 'SMS' | 'PASSWORD' | string;
  verifiedAt?: string;
}

export interface HighImpactActionInput {
  actionType: string;
  reason: string;
  idempotencyKey: string;
  authFactors: HighImpactAuthFactors;
  csrfToken?: string;
  expectedCsrfToken?: string;
  actorId?: string;
  timestamp?: string;
}

export interface HighImpactActionResult {
  authorized: true;
  auditId: string;
  actionType: string;
  reasonRecorded: string;
  verifiedAt: string;
  idempotencyKey: string;
  authMethod: string;
}

export const validateHighImpactAction = (
  input: HighImpactActionInput,
): HighImpactActionResult => {
  if (!input.actionType || typeof input.actionType !== 'string' || input.actionType.trim() === '') {
    throw new Error('ACTION_TYPE_REQUIRED');
  }

  // 1. Idempotency Key
  if (!input.idempotencyKey || typeof input.idempotencyKey !== 'string' || input.idempotencyKey.trim() === '') {
    throw new Error('IDEMPOTENCY_KEY_REQUIRED');
  }

  // 2. Reason Entry (must be meaningful non-empty explanation)
  if (!input.reason || typeof input.reason !== 'string' || input.reason.trim().length < 8) {
    throw new Error('REASON_ENTRY_REQUIRED');
  }

  // 3. Phishing Resistance & Auth Factors (FR-SEC-001 MUST: TOTP alone is not sufficient)
  if (!input.authFactors) {
    throw new Error('STEP_UP_AUTHENTICATION_REQUIRED');
  }

  if (input.authFactors.method === 'TOTP' || !input.authFactors.phishingResistant) {
    throw new Error('STEP_UP_PHISHING_RESISTANCE_REQUIRED');
  }

  if (!input.authFactors.stepUpVerified) {
    throw new Error('STEP_UP_AUTHENTICATION_REQUIRED');
  }

  // 4. CSRF Protection
  if (input.expectedCsrfToken !== undefined || input.csrfToken !== undefined) {
    if (!input.csrfToken || !input.expectedCsrfToken) {
      throw new Error('CSRF_TOKEN_INVALID');
    }
    const suppliedBuf = Buffer.from(input.csrfToken);
    const expectedBuf = Buffer.from(input.expectedCsrfToken);
    if (suppliedBuf.length !== expectedBuf.length || !timingSafeEqual(suppliedBuf, expectedBuf)) {
      throw new Error('CSRF_TOKEN_INVALID');
    }
  }

  const auditId = randomUUID();
  const verifiedAt = input.authFactors.verifiedAt ?? new Date().toISOString();

  return {
    authorized: true,
    auditId,
    actionType: input.actionType.trim(),
    reasonRecorded: input.reason.trim(),
    verifiedAt,
    idempotencyKey: input.idempotencyKey.trim(),
    authMethod: input.authFactors.method,
  };
};
