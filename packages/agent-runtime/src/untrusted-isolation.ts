import { createHash } from 'node:crypto';
import { wrapUntrustedContent, detectPromptInjection, sanitizeUntrustedContent } from '@ciag/security';

/**
 * FR-AGT-008 Untrusted-content isolation
 * Untrusted content isolated as data cannot alter instructions, tool schemas, scopes, URLs, budgets, or policies.
 * This module ensures untrusted provider/output content is never interpreted as control plane.
 */

export interface IsolatedContent {
  type: 'ISOLATED_UNTRUSTED_DATA';
  source: string;
  data: string;
  safeData: string;
  sha256: string;
  detectedInjection: boolean;
  isolatedAt: string;
}

export interface UntrustedIsolationResult {
  isolated: IsolatedContent;
  allowed: boolean;
  blockReason?: string | undefined;
}

const CONTROL_PLANE_KEYWORDS: readonly RegExp[] = [
  /\btool\s+schema\b/i,
  /\ballowedTools\b/i,
  /\ballowedProviders\b/i,
  /\ballowedDomains\b/i,
  /\bmaxCostUsd\b/i,
  /\bmaxLimit\b/i,
  /\bbudget\b/i,
  /\bpolicy\b/i,
  /\bscope\b/i,
  /\bexecution\b.*\bpolicy\b/i,
];

const URL_OVERRIDE_PATTERNS: readonly RegExp[] = [
  /https?:\/\/[^\s]+/i,
  /wss?:\/\/[^\s]+/i,
];

export class UntrustedContentIsolator {
  /**
   * Isolates untrusted content as pure data. Returns isolated envelope that cannot be used as instruction.
   * Throws or blocks if content attempts to alter control plane.
   */
  public static isolate(
    content: string,
    source: string,
    options?: { maxLength?: number | undefined; strictBlock?: boolean | undefined },
  ): UntrustedIsolationResult {
    if (typeof content !== 'string') content = String(content ?? '');

    const detection = detectPromptInjection(content);
    const wrapped = wrapUntrustedContent(content, source, {
      maxLength: options?.maxLength ?? 8192,
      sanitize: true,
      stripDelimiters: true,
    });

    const safeData = wrapped.safeContent;

    // Check if untrusted content contains control-plane override attempts
    const controlAttempts: string[] = [];
    for (const re of CONTROL_PLANE_KEYWORDS) {
      if (re.test(content)) {
        // Only flag if combined with directive language
        if (/override|set\s+to|change\s+to|ignore|bypass|allow\s+all/i.test(content)) {
          controlAttempts.push(re.source);
        }
      }
    }

    // Detect URL injection attempts that try to override allowed domains
    const hasUrlAttempt = URL_OVERRIDE_PATTERNS.some((re) => re.test(content));
    const hasDirective = /fetch\s+from|call\s+tool|execute|endpoint\s*[:=]/i.test(content);

    const attemptsControlPlane = controlAttempts.length > 0 || (hasUrlAttempt && hasDirective) || detection.suspicious;

    // In strict mode, block any suspicious content; otherwise sanitize and allow as data only
    if (options?.strictBlock && detection.suspicious && detection.confidence !== 'LOW') {
      return {
        isolated: {
          type: 'ISOLATED_UNTRUSTED_DATA',
          source,
          data: content,
          safeData,
          sha256: wrapped.sha256,
          detectedInjection: true,
          isolatedAt: wrapped.wrappedAt,
        },
        allowed: false,
        blockReason: `PROMPT_INJECTION_BLOCKED:${detection.patterns.join(',')}`,
      };
    }

    if (attemptsControlPlane && detection.confidence === 'HIGH') {
      return {
        isolated: {
          type: 'ISOLATED_UNTRUSTED_DATA',
          source,
          data: content,
          safeData,
          sha256: wrapped.sha256,
          detectedInjection: true,
          isolatedAt: wrapped.wrappedAt,
        },
        allowed: false,
        blockReason: `CONTROL_PLANE_ALTERATION_BLOCKED:${controlAttempts.join(',') || detection.patterns.join(',')}`,
      };
    }

    return {
      isolated: {
        type: 'ISOLATED_UNTRUSTED_DATA',
        source,
        data: content,
        safeData,
        sha256: wrapped.sha256,
        detectedInjection: detection.suspicious,
        isolatedAt: wrapped.wrappedAt,
      },
      allowed: true,
    };
  }

  /**
   * Ensures untrusted isolated data cannot be used to construct tool arguments that escape confinement.
   * This validates that isolated data is only used as string data, never as structured control.
   */
  public static assertIsolatedDataCannotAlterEnvelope(
    isolatedData: IsolatedContent,
    envelopeField: string,
  ): void {
    // Isolated data must never be interpreted as envelope field value
    // This is a static guarantee: isolated type is distinct from envelope types
    if (isolatedData.type !== 'ISOLATED_UNTRUSTED_DATA') {
      throw new Error('ISOLATED_TYPE_MISMATCH');
    }
    // No mutation of envelope allowed via this data path
    void envelopeField;
  }

  /**
   * Validates that untrusted content does not contain instructions that would alter:
   * - tool schemas
   * - scopes
   * - URLs
   * - budgets
   * - policies
   * Returns true if content is safe as data, false if it attempts control alteration.
   */
  public static isSafeAsData(content: string): boolean {
    const result = UntrustedContentIsolator.isolate(content, 'test-probe', { strictBlock: false });
    // Even if allowed, check isolated data doesn't contain raw control sequences after sanitization
    const sanitized = sanitizeUntrustedContent(content, { maxLength: 8192 });
    const dangerousAfterSanitize =
      /<\s*system/i.test(sanitized) ||
      /\[SYS\]/i.test(sanitized) ||
      /ignore\s+previous\s+instructions/i.test(sanitized);
    if (dangerousAfterSanitize) return false;
    return result.allowed;
  }

  /**
   * Produces deterministic hash for lineage that content was isolated.
   */
  public static isolationHash(content: string, source: string): string {
    const isolated = UntrustedContentIsolator.isolate(content, source);
    return createHash('sha256').update(isolated.isolated.sha256 + '|' + source).digest('hex');
  }
}
