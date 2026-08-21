import type { ToolAuthorizationEnvelope } from '@ciag/shared-schemas';
import { ConfinementViolationError } from './errors.js';

export interface ConfinementValidationResult {
  valid: boolean;
  error?: ConfinementViolationError;
}

export class ToolArgumentConfinementValidator {
  private static parseTimestampToMs(value: unknown): number | undefined {
    if (typeof value === 'number') {
      // If seconds timestamp (< 100_000_000_000), convert to ms
      return value < 100_000_000_000 ? value * 1000 : value;
    }
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) return parsed;
      const num = Number(value);
      if (!Number.isNaN(num)) {
        return num < 100_000_000_000 ? num * 1000 : num;
      }
    }
    return undefined;
  }

  private static extractHost(value: string, toolName = 'unknown'): string {
    const candidate = value.trim();

    // Check for credential / userinfo injection before parsing
    if (
      candidate.startsWith('http://') ||
      candidate.startsWith('https://') ||
      candidate.startsWith('ws://') ||
      candidate.startsWith('wss://')
    ) {
      try {
        const url = new URL(candidate);
        if (url.username !== '' || url.password !== '') {
          throw new ConfinementViolationError(
            'URL_NOT_ALLOWED',
            `Credential/userinfo syntax (user:pass@host) is strictly forbidden in URL: "${value}"`,
            toolName,
          );
        }
        return url.hostname.toLowerCase();
      } catch (err) {
        if (err instanceof ConfinementViolationError) throw err;
        throw new ConfinementViolationError(
          'URL_NOT_ALLOWED',
          `Malformed URL string: "${value}"`,
          toolName,
        );
      }
    }

    // Bare hostname / domain check - ensure no userinfo injection (e.g. evil.com@jup.ag)
    const hostSegment = candidate.split('/')[0] ?? '';
    if (hostSegment.includes('@')) {
      throw new ConfinementViolationError(
        'URL_NOT_ALLOWED',
        `Credential/userinfo syntax (@) is strictly forbidden in domain/host: "${value}"`,
        toolName,
      );
    }

    // Bracketed IPv6
    if (hostSegment.startsWith('[')) {
      const closeIdx = hostSegment.indexOf(']');
      if (closeIdx !== -1) {
        return hostSegment.slice(1, closeIdx).toLowerCase();
      }
    }

    // Strip port if present
    const parts = hostSegment.split(':');
    if (parts.length === 2 && parts[0]) {
      return parts[0].toLowerCase();
    }

    return hostSegment.toLowerCase();
  }

  private static isDomainAllowed(host: string, allowedDomains: readonly string[]): boolean {
    const normalizedHost = host.toLowerCase();
    return allowedDomains.some((allowed) => {
      const allowedFirst = allowed.toLowerCase().replace(/^https?:\/\//, '').split('/')[0] ?? '';
      const normalizedAllowed = allowedFirst;
      return (
        normalizedHost === normalizedAllowed ||
        normalizedHost.endsWith(`.${normalizedAllowed}`)
      );
    });
  }

  private static normalizeAddress(address: string): string {
    if (address.startsWith('0x') || address.startsWith('0X')) {
      return address.toLowerCase();
    }
    return address; // Keep base58 (Solana) as exact string
  }

  /**
   * Validates tool invocation arguments against the deterministic planner envelope and profile declared tools.
   * Throws ConfinementViolationError immediately if any argument broadens scope.
   */
  public static assertConforms(
    toolName: string,
    args: Record<string, unknown> = {},
    envelope: ToolAuthorizationEnvelope,
    declaredTools?: readonly string[],
  ): void {
    // 1. Tool allowlist
    if (!envelope.allowedTools.includes(toolName)) {
      throw new ConfinementViolationError(
        'TOOL_NOT_ALLOWED',
        `Tool "${toolName}" is not in the authorization envelope allowedTools: [${envelope.allowedTools.join(', ')}]`,
        toolName,
        args,
      );
    }

    if (declaredTools && !declaredTools.includes(toolName)) {
      throw new ConfinementViolationError(
        'TOOL_NOT_ALLOWED',
        `Tool "${toolName}" is not declared in the active model profile declaredTools: [${declaredTools.join(', ')}]`,
        toolName,
        args,
      );
    }

    // 2. Deep recursive inspection of arguments
    this.scanRecursive(toolName, args, envelope);
  }

  public static validate(
    toolName: string,
    args: Record<string, unknown> = {},
    envelope: ToolAuthorizationEnvelope,
    declaredTools?: readonly string[],
  ): ConfinementValidationResult {
    try {
      this.assertConforms(toolName, args, envelope, declaredTools);
      return { valid: true };
    } catch (err) {
      if (err instanceof ConfinementViolationError) {
        return { valid: false, error: err };
      }
      throw err;
    }
  }

  private static scanRecursive(
    toolName: string,
    target: unknown,
    envelope: ToolAuthorizationEnvelope,
    currentKey = '',
  ): void {
    if (target === null || target === undefined) return;

    if (Array.isArray(target)) {
      for (const item of target) {
        this.scanRecursive(toolName, item, envelope, currentKey);
      }
      return;
    }

    if (typeof target === 'object') {
      for (const [key, value] of Object.entries(target as Record<string, unknown>)) {
        this.checkKeyAndValue(toolName, key, value, envelope);
        this.scanRecursive(toolName, value, envelope, key);
      }
      return;
    }
  }

  private static checkKeyAndValue(
    toolName: string,
    key: string,
    value: unknown,
    envelope: ToolAuthorizationEnvelope,
  ): void {
    const lowerKey = key.toLowerCase();

    // Provider scope check
    if (
      envelope.allowedProviders &&
      envelope.allowedProviders.length > 0 &&
      (lowerKey.includes('provider') ||
        lowerKey === 'source' ||
        lowerKey === 'sourceid' ||
        lowerKey.includes('feed'))
    ) {
      if (typeof value === 'string') {
        const allowed = envelope.allowedProviders.map((p) => p.toLowerCase());
        if (!allowed.includes(value.toLowerCase())) {
          throw new ConfinementViolationError(
            'PROVIDER_NOT_ALLOWED',
            `Provider "${value}" is outside envelope allowedProviders: [${envelope.allowedProviders.join(', ')}]`,
            toolName,
          );
        }
      }
    }

    // URL & Domain check
    if (
      envelope.allowedDomains &&
      envelope.allowedDomains.length > 0 &&
      (lowerKey.includes('domain') ||
        lowerKey.includes('host') ||
        lowerKey.includes('url') ||
        lowerKey.includes('endpoint') ||
        lowerKey.includes('uri') ||
        lowerKey.includes('link') ||
        lowerKey.includes('href') ||
        lowerKey.includes('target') ||
        (typeof value === 'string' &&
          (value.startsWith('http://') ||
            value.startsWith('https://') ||
            value.startsWith('ws://') ||
            value.startsWith('wss://') ||
            /^[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(value.trim()))))
    ) {
      if (typeof value === 'string' && value.trim().length > 0) {
        const host = this.extractHost(value);
        if (host && !this.isDomainAllowed(host, envelope.allowedDomains)) {
          throw new ConfinementViolationError(
            'URL_NOT_ALLOWED',
            `URL/domain "${value}" (host: "${host}") is outside envelope allowedDomains: [${envelope.allowedDomains.join(', ')}]`,
            toolName,
          );
        }
      }
    }

    // Chain check
    if (envelope.allowedChains && envelope.allowedChains.length > 0) {
      const isChainKey =
        lowerKey.includes('chain') ||
        lowerKey === 'network' ||
        lowerKey === 'blockchain' ||
        lowerKey === 'ecosystem';
      const KNOWN_CHAINS = [
        'solana',
        'ethereum',
        'base',
        'arbitrum',
        'polygon',
        'optimism',
        'avalanche',
        'bsc',
        'mainnet',
      ];
      const isChainValue = (v: unknown): boolean =>
        typeof v === 'string' && KNOWN_CHAINS.includes(v.toLowerCase());

      const allowed = envelope.allowedChains.map((c) => c.toLowerCase());
      if (typeof value === 'string' && (isChainKey || isChainValue(value))) {
        if (!allowed.includes(value.toLowerCase())) {
          throw new ConfinementViolationError(
            'CHAIN_NOT_ALLOWED',
            `Chain "${value}" is outside envelope allowedChains: [${envelope.allowedChains.join(', ')}]`,
            toolName,
          );
        }
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string' && (isChainKey || isChainValue(item))) {
            if (!allowed.includes(item.toLowerCase())) {
              throw new ConfinementViolationError(
                'CHAIN_NOT_ALLOWED',
                `Chain "${item}" in list is outside envelope allowedChains: [${envelope.allowedChains.join(', ')}]`,
                toolName,
              );
            }
          }
        }
      }
    }

    // Address check (key-based or value-pattern based)
    if (envelope.allowedAddresses && envelope.allowedAddresses.length > 0) {
      const isAddressKey =
        lowerKey.includes('address') ||
        lowerKey.includes('mint') ||
        lowerKey === 'account' ||
        lowerKey.includes('recipient') ||
        lowerKey.includes('wallet') ||
        lowerKey.includes('token') ||
        lowerKey === 'contract';

      const isAddressValue = (v: unknown): boolean =>
        typeof v === 'string' &&
        (/^0x[a-fA-F0-9]{40}$/.test(v) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v));

      const allowed = envelope.allowedAddresses.map((a) => this.normalizeAddress(a));
      if (typeof value === 'string' && (isAddressKey || isAddressValue(value))) {
        const normalized = this.normalizeAddress(value);
        if (!allowed.includes(normalized)) {
          throw new ConfinementViolationError(
            'ADDRESS_NOT_ALLOWED',
            `Address "${value}" is outside envelope allowedAddresses: [${envelope.allowedAddresses.join(', ')}]`,
            toolName,
          );
        }
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string' && (isAddressKey || isAddressValue(item))) {
            const normalized = this.normalizeAddress(item);
            if (!allowed.includes(normalized)) {
              throw new ConfinementViolationError(
                'ADDRESS_NOT_ALLOWED',
                `Address "${item}" in list is outside envelope allowedAddresses: [${envelope.allowedAddresses.join(', ')}]`,
                toolName,
              );
            }
          }
        }
      }
    }

    // Time range check
    if (envelope.timeRange) {
      const isTimeKey =
        lowerKey.includes('time') ||
        lowerKey.includes('stamp') ||
        lowerKey.includes('asof') ||
        lowerKey.includes('date') ||
        lowerKey.includes('since') ||
        lowerKey.includes('until') ||
        lowerKey.includes('created') ||
        lowerKey.includes('future') ||
        lowerKey === 'from' ||
        lowerKey === 'to' ||
        lowerKey === 'start' ||
        lowerKey === 'end';
      const isTimeValue =
        (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) ||
        (typeof value === 'number' && value > 1_000_000_000);

      if (isTimeKey || isTimeValue) {
        const tsMs = this.parseTimestampToMs(value);
        if (tsMs !== undefined) {
          const maxMs = new Date(envelope.timeRange.maxTimestamp).getTime();
          if (tsMs > maxMs) {
            throw new ConfinementViolationError(
              'TIME_RANGE_NOT_ALLOWED',
              `Timestamp "${value}" (${new Date(tsMs).toISOString()}) exceeds envelope maxTimestamp "${envelope.timeRange.maxTimestamp}"`,
              toolName,
            );
          }
          if (envelope.timeRange.minTimestamp) {
            const minMs = new Date(envelope.timeRange.minTimestamp).getTime();
            if (tsMs < minMs) {
              throw new ConfinementViolationError(
                'TIME_RANGE_NOT_ALLOWED',
                `Timestamp "${value}" (${new Date(tsMs).toISOString()}) precedes envelope minTimestamp "${envelope.timeRange.minTimestamp}"`,
                toolName,
              );
            }
          }
        }
      }
    }

    // Output size & limit check
    if (
      envelope.maxLimit !== undefined &&
      (lowerKey === 'limit' ||
        lowerKey === 'pagesize' ||
        lowerKey === 'count' ||
        lowerKey === 'maxresults' ||
        lowerKey === 'topn' ||
        lowerKey === 'take' ||
        lowerKey === 'size')
    ) {
      if (typeof value === 'number' && value > envelope.maxLimit) {
        throw new ConfinementViolationError(
          'OUTPUT_SIZE_NOT_ALLOWED',
          `Parameter "${key}" value ${value} exceeds envelope maxLimit ${envelope.maxLimit}`,
          toolName,
        );
      }
    }

    if (
      envelope.maxOutputSizeBytes !== undefined &&
      (lowerKey === 'maxoutputsizebytes' ||
        lowerKey === 'maxbytes' ||
        lowerKey === 'bytelimit' ||
        lowerKey === 'outputsize')
    ) {
      if (typeof value === 'number' && value > envelope.maxOutputSizeBytes) {
        throw new ConfinementViolationError(
          'OUTPUT_SIZE_NOT_ALLOWED',
          `Parameter "${key}" value ${value} exceeds envelope maxOutputSizeBytes ${envelope.maxOutputSizeBytes}`,
          toolName,
        );
      }
    }

    // Entity check
    if (envelope.allowedEntities && envelope.allowedEntities.length > 0) {
      const isEntityKey =
        lowerKey.includes('entity') ||
        lowerKey.includes('asset') ||
        lowerKey.includes('candidate');

      if (typeof value === 'string' && isEntityKey) {
        if (!envelope.allowedEntities.includes(value)) {
          throw new ConfinementViolationError(
            'ENTITY_NOT_ALLOWED',
            `Entity "${value}" is outside envelope allowedEntities: [${envelope.allowedEntities.join(', ')}]`,
            toolName,
          );
        }
      } else if (Array.isArray(value) && isEntityKey) {
        for (const item of value) {
          if (typeof item === 'string' && !envelope.allowedEntities.includes(item)) {
            throw new ConfinementViolationError(
              'ENTITY_NOT_ALLOWED',
              `Entity "${item}" in list is outside envelope allowedEntities: [${envelope.allowedEntities.join(', ')}]`,
              toolName,
            );
          }
        }
      }
    }

    // Allowed fields check
    if (envelope.allowedFields) {
      const toolAllowedFields = envelope.allowedFields[toolName];
      const isFieldListKey =
        lowerKey === 'fields' ||
        lowerKey === 'requestedfields' ||
        lowerKey === 'columns' ||
        lowerKey === 'properties' ||
        lowerKey === 'attributes';

      if (toolAllowedFields && isFieldListKey) {
        if (typeof value === 'string') {
          if (!toolAllowedFields.includes(value)) {
            throw new ConfinementViolationError(
              'FIELD_NOT_ALLOWED',
              `Field "${value}" is outside envelope allowedFields for ${toolName}: [${toolAllowedFields.join(', ')}]`,
              toolName,
            );
          }
        } else if (Array.isArray(value)) {
          for (const item of value) {
            if (typeof item === 'string' && !toolAllowedFields.includes(item)) {
              throw new ConfinementViolationError(
                'FIELD_NOT_ALLOWED',
                `Field "${item}" in list is outside envelope allowedFields for ${toolName}: [${toolAllowedFields.join(', ')}]`,
                toolName,
              );
            }
          }
        }
      }
    }

    // Deadline check
    if (envelope.deadlineAt) {
      const deadlineMs = new Date(envelope.deadlineAt).getTime();
      const isTimeKey =
        lowerKey.includes('time') ||
        lowerKey.includes('stamp') ||
        lowerKey.includes('asof') ||
        lowerKey.includes('date') ||
        lowerKey.includes('since') ||
        lowerKey.includes('until');
      if (isTimeKey) {
        const tsMs = this.parseTimestampToMs(value);
        if (tsMs !== undefined && tsMs > deadlineMs) {
          throw new ConfinementViolationError(
            'TIME_RANGE_NOT_ALLOWED',
            `Timestamp "${value}" (${new Date(tsMs).toISOString()}) exceeds envelope deadlineAt "${envelope.deadlineAt}"`,
            toolName,
          );
        }
      }
    }

    // Cost check
    if (
      envelope.maxCostUsd !== undefined &&
      (lowerKey === 'maxcostusd' ||
        lowerKey === 'estimatedcostusd' ||
        lowerKey === 'costusd' ||
        lowerKey === 'costlimitusd' ||
        lowerKey === 'budgetusd')
    ) {
      if (typeof value === 'number' && value > envelope.maxCostUsd) {
        throw new ConfinementViolationError(
          'COST_NOT_ALLOWED',
          `Cost parameter "${key}" value ${value} exceeds envelope maxCostUsd ${envelope.maxCostUsd}`,
          toolName,
        );
      }
    }
  }
}

