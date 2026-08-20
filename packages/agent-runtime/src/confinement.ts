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

  private static extractHost(value: string): string {
    try {
      if (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('ws://') || value.startsWith('wss://')) {
        const url = new URL(value);
        return url.hostname.toLowerCase();
      }
      // If it's a domain name (e.g., api.dexscreener.com)
      const sanitized = value.split('/')[0].split(':')[0].toLowerCase();
      return sanitized;
    } catch {
      return value.toLowerCase();
    }
  }

  private static isDomainAllowed(host: string, allowedDomains: readonly string[]): boolean {
    const normalizedHost = host.toLowerCase();
    return allowedDomains.some((allowed) => {
      const normalizedAllowed = allowed.toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
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
      (lowerKey === 'provider' ||
        lowerKey === 'dataprovider' ||
        lowerKey === 'modelprovider' ||
        lowerKey === 'source' ||
        lowerKey === 'sourceid' ||
        lowerKey === 'feed' ||
        lowerKey === 'feedprovider')
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
      (lowerKey === 'url' ||
        lowerKey === 'endpoint' ||
        lowerKey === 'domain' ||
        lowerKey === 'uri' ||
        lowerKey === 'link' ||
        lowerKey === 'href' ||
        lowerKey === 'host' ||
        lowerKey === 'hostname' ||
        (typeof value === 'string' && (value.startsWith('http://') || value.startsWith('https://'))))
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
    if (
      envelope.allowedChains &&
      envelope.allowedChains.length > 0 &&
      (lowerKey === 'chain' ||
        lowerKey === 'chainid' ||
        lowerKey === 'network' ||
        lowerKey === 'blockchain' ||
        lowerKey === 'ecosystem')
    ) {
      const allowed = envelope.allowedChains.map((c) => c.toLowerCase());
      if (typeof value === 'string') {
        if (!allowed.includes(value.toLowerCase())) {
          throw new ConfinementViolationError(
            'CHAIN_NOT_ALLOWED',
            `Chain "${value}" is outside envelope allowedChains: [${envelope.allowedChains.join(', ')}]`,
            toolName,
          );
        }
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string' && !allowed.includes(item.toLowerCase())) {
            throw new ConfinementViolationError(
              'CHAIN_NOT_ALLOWED',
              `Chain "${item}" in list is outside envelope allowedChains: [${envelope.allowedChains.join(', ')}]`,
              toolName,
            );
          }
        }
      }
    }

    // Address check
    if (
      envelope.allowedAddresses &&
      envelope.allowedAddresses.length > 0 &&
      (lowerKey === 'address' ||
        lowerKey === 'addresses' ||
        lowerKey === 'contractaddress' ||
        lowerKey === 'tokenaddress' ||
        lowerKey === 'pooladdress' ||
        lowerKey === 'mint' ||
        lowerKey === 'mintaddress' ||
        lowerKey === 'account' ||
        lowerKey === 'owneraddress' ||
        lowerKey === 'walletaddress' ||
        lowerKey === 'recipient' ||
        lowerKey === 'targetaddress')
    ) {
      const allowed = envelope.allowedAddresses.map((a) => this.normalizeAddress(a));
      if (typeof value === 'string') {
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
          if (typeof item === 'string') {
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
    if (
      envelope.timeRange &&
      (lowerKey === 'from' ||
        lowerKey === 'to' ||
        lowerKey === 'starttime' ||
        lowerKey === 'endtime' ||
        lowerKey === 'timestamp' ||
        lowerKey === 'asof' ||
        lowerKey === 'mintimestamp' ||
        lowerKey === 'maxtimestamp' ||
        lowerKey === 'since' ||
        lowerKey === 'until' ||
        lowerKey === 'eventtime' ||
        lowerKey === 'observedat' ||
        lowerKey === 'blocktime')
    ) {
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
