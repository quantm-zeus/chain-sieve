import { createHash } from 'node:crypto';

/**
 * Untrusted content isolation and prompt injection defense.
 * Ensures token metadata, social text, provider output, and web pages
 * cannot hijack model instructions or system policies.
 */

export interface UntrustedContentEnvelope {
  type: 'UNTRUSTED_CONTENT';
  source: string;
  safeContent: string;
  sanitized: boolean;
  sha256: string;
  wrappedAt: string;
}

export interface PromptInjectionScanResult {
  suspicious: boolean;
  patterns: string[];
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
}

const INJECTION_PATTERNS: readonly { pattern: RegExp; name: string; weight: number }[] = Object.freeze([
  { pattern: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions|prompts|rules|constraints)/i, name: 'ignore_previous_instructions', weight: 3 },
  { pattern: /disregard\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions|prompts|rules|constraints)/i, name: 'disregard_previous_instructions', weight: 3 },
  { pattern: /system\s+(?:prompt|instruction)\s+override/i, name: 'system_prompt_override', weight: 3 },
  { pattern: /you\s+are\s+now\s+(?:in\s+developer\s+mode|DAN|an\s+unrestricted\s+AI|unfiltered)/i, name: 'jailbreak_persona_shift', weight: 3 },
  { pattern: /\bdo\s+anything\s+now\b/i, name: 'dan_jailbreak', weight: 3 },
  { pattern: /bypass\s+(?:all\s+)?(?:safety|security|verification|policy)\s+(?:filters|checks|rules)/i, name: 'bypass_security_checks', weight: 3 },
  { pattern: /execute\s+(?:(?:the\s+following|this)\s+)?(?:trade|swap|transaction|order|signing)\s+immediately/i, name: 'unauthorized_execution_instruction', weight: 3 },
  { pattern: /<\/?system(?:_instruction)?>/i, name: 'system_tag_smuggling', weight: 2 },
  { pattern: /\[\/?(?:INST|SYS|SYSTEM|ASSISTANT)\]/i, name: 'instruction_tag_smuggling', weight: 2 },
  { pattern: /<!--\s*(?:system|override|admin)\s*-->/i, name: 'html_comment_smuggling', weight: 2 },
  { pattern: /```(?:system|instruction|admin)\b/i, name: 'codeblock_role_smuggling', weight: 2 },
  { pattern: /\boutput\s+(?:your\s+)?(?:system\s+prompt|initial\s+instructions|secret\s+key)/i, name: 'prompt_exfiltration_attempt', weight: 2 },
  { pattern: /\bprint\s+(?:the\s+)?(?:full\s+)?(?:system\s+instructions|system\s+message)\b/i, name: 'instruction_extraction', weight: 2 },
  { pattern: /\bfrom\s+now\s+on\s+you\s+(?:must|will)\s+ignore\b/i, name: 'future_instruction_override', weight: 2 },
]);

export const sanitizeUntrustedContent = (
  input: string,
  options?: { maxLength?: number; stripDelimiters?: boolean },
): string => {
  if (typeof input !== 'string') return '';

  let sanitized = input;

  // 1. Remove zero-width characters and invisible control code points
  sanitized = sanitized.replace(/[\u200B-\u200D\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

  // 2. Strip Unicode bidirectional override characters that can obfuscate attacks
  sanitized = sanitized.replace(/[\u202A-\u202E\u2066-\u2069]/g, '');

  // 3. Neutralize known system / role delimiter tokens if requested or by default
  if (options?.stripDelimiters !== false) {
    sanitized = sanitized
      .replace(/<(\/?)system>/gi, '&lt;$1system&gt;')
      .replace(/<(\/?)system_instruction>/gi, '&lt;$1system_instruction&gt;')
      .replace(/\[(\/?)(INST|SYS|SYSTEM|ASSISTANT)\]/gi, '\\[$1$2\\]')
      .replace(/<!--\s*system/gi, '&lt;!-- system')
      .replace(/```system/gi, '``` untrusted-system');
  }

  // 4. Bound length
  if (options?.maxLength !== undefined && options.maxLength > 0) {
    sanitized = sanitized.slice(0, options.maxLength);
  }

  return sanitized;
};

export const detectPromptInjection = (input: string): PromptInjectionScanResult => {
  if (typeof input !== 'string' || input.trim() === '') {
    return { suspicious: false, patterns: [], confidence: 'LOW' };
  }

  const matchedPatterns: string[] = [];
  let score = 0;

  for (const item of INJECTION_PATTERNS) {
    if (item.pattern.test(input)) {
      matchedPatterns.push(item.name);
      score += item.weight;
    }
  }

  const suspicious = matchedPatterns.length > 0;
  const confidence: 'LOW' | 'MEDIUM' | 'HIGH' =
    score >= 4 ? 'HIGH' : score >= 2 ? 'MEDIUM' : suspicious ? 'LOW' : 'LOW';

  return {
    suspicious,
    patterns: matchedPatterns,
    confidence,
  };
};

export const wrapUntrustedContent = (
  content: string,
  source: string,
  options?: { maxLength?: number; sanitize?: boolean },
): UntrustedContentEnvelope => {
  const safeContent = options?.sanitize !== false
    ? sanitizeUntrustedContent(content, { maxLength: options?.maxLength })
    : content;

  const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');

  return {
    type: 'UNTRUSTED_CONTENT',
    source,
    safeContent,
    sanitized: options?.sanitize !== false,
    sha256,
    wrappedAt: new Date().toISOString(),
  };
};

export const assertPromptIntegrity = (
  systemPrompt: string,
  untrustedInputs: readonly string[],
): void => {
  if (!systemPrompt || typeof systemPrompt !== 'string') {
    throw new Error('SYSTEM_PROMPT_REQUIRED');
  }

  for (const input of untrustedInputs) {
    const scan = detectPromptInjection(input);
    if (scan.suspicious && (scan.confidence === 'HIGH' || scan.confidence === 'MEDIUM')) {
      throw new Error(`PROMPT_INTEGRITY_VIOLATION:${scan.patterns.join(',')}`);
    }
  }
};
