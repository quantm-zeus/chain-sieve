import { isIP } from 'node:net';

/**
 * SSRF and egress security controls (FR-SEC-004).
 * Prevents access to private networks, loopbacks, link-local, cloud metadata,
 * and handles DNS rebinding / mixed-encoding obfuscations.
 */

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'instance-data',
  'api.ec2.internal',
]);

export const isPrivateOrBlockedAddress = (hostOrIp: string): boolean => {
  if (!hostOrIp || typeof hostOrIp !== 'string') return true;

  let normalized = hostOrIp.trim().toLowerCase();

  // Decode percent-encoded hosts (e.g., %31%32%37.0.0.1)
  try {
    if (normalized.includes('%')) {
      normalized = decodeURIComponent(normalized).toLowerCase();
    }
  } catch {
    return true; // Malformed percent-encoding is blocked
  }

  // Strip trailing dot (DNS root domain notation e.g., localhost.)
  if (normalized.endsWith('.')) {
    normalized = normalized.slice(0, -1);
  }

  // Strip brackets from IPv6 literal
  let cleanHost = normalized.startsWith('[') && normalized.endsWith(']')
    ? normalized.slice(1, -1)
    : normalized;

  // Strip IPv6 zone index (e.g. fe80::1%lo0)
  const zoneIdx = cleanHost.indexOf('%');
  if (zoneIdx !== -1) {
    cleanHost = cleanHost.slice(0, zoneIdx);
  }

  if (BLOCKED_HOSTNAMES.has(cleanHost)) return true;

  // Check decimal IP notations like 2130706433 (127.0.0.1) or hex representations
  if (/^\d+$/.test(cleanHost)) {
    const num = Number(cleanHost);
    if (Number.isFinite(num) && num >= 0 && num <= 0xffffffff) {
      const b1 = (num >> 24) & 255;
      const b2 = (num >> 16) & 255;
      const b3 = (num >> 8) & 255;
      const b4 = num & 255;
      return isPrivateOrBlockedAddress(`${b1}.${b2}.${b3}.${b4}`);
    }
  }

  // Check hex notation (0x7f000001)
  if (/^0x[0-9a-f]+$/i.test(cleanHost)) {
    const num = parseInt(cleanHost, 16);
    if (Number.isFinite(num) && num >= 0 && num <= 0xffffffff) {
      const b1 = (num >> 24) & 255;
      const b2 = (num >> 16) & 255;
      const b3 = (num >> 8) & 255;
      const b4 = num & 255;
      return isPrivateOrBlockedAddress(`${b1}.${b2}.${b3}.${b4}`);
    }
  }

  // Check dotted notation (including 1, 2, 3, 4 parts with octal/hex/decimal representations e.g. 127.1)
  if (cleanHost.includes('.')) {
    const rawParts = cleanHost.split('.');
    if (rawParts.length >= 1 && rawParts.length <= 4 && rawParts.every((p) => /^(?:0x[0-9a-f]+|0[0-7]+|\d+)$/i.test(p))) {
      const resolved = rawParts.map((part) => {
        if (/^0x/i.test(part)) {
          return parseInt(part, 16);
        }
        if (part.length > 1 && part.startsWith('0')) {
          if (!/^[0-7]+$/.test(part)) {
            return NaN; // Block invalid octal e.g. 08, 09 fail-closed
          }
          return parseInt(part, 8);
        }
        return Number(part);
      });

      if (resolved.some((p) => Number.isNaN(p) || p < 0)) {
        return true; // Fail closed on malformed
      }

      let b0 = 0, b1 = 0;
      if (resolved.length === 4) {
        if (resolved.some((p) => p > 255)) return true;
        [b0, b1] = resolved as [number, number];
      } else if (resolved.length === 3) {
        if (resolved[0]! > 255 || resolved[1]! > 255 || resolved[2]! > 0xffff) return true;
        b0 = resolved[0]!;
        b1 = resolved[1]!;
      } else if (resolved.length === 2) {
        if (resolved[0]! > 255 || resolved[1]! > 0xffffff) return true;
        b0 = resolved[0]!;
        b1 = (resolved[1]! >> 16) & 255;
      } else if (resolved.length === 1) {
        if (resolved[0]! > 0xffffffff) return true;
        b0 = (resolved[0]! >> 24) & 255;
        b1 = (resolved[0]! >> 16) & 255;
      }

      // Loopback: 127.0.0.0/8, 0.0.0.0/8
      if (b0 === 127 || b0 === 0) return true;

      // RFC 1918 Private: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
      if (b0 === 10) return true;
      if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
      if (b0 === 192 && b1 === 168) return true;

      // Link-local / Cloud metadata: 169.254.0.0/16 (e.g., AWS/GCP/Azure 169.254.169.254)
      if (b0 === 169 && b1 === 254) return true;

      // Carrier-grade NAT: 100.64.0.0/10 (e.g., 100.64.0.0 to 100.127.255.255, Alibaba metadata 100.100.100.200)
      if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;

      // Documentation / Benchmark: 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24, 198.18.0.0/15
      if (b0 === 192 && b1 === 0) return true;
      if (b0 === 198 && (b1 === 51 || (b1 >= 18 && b1 <= 19))) return true;
      if (b0 === 203 && b1 === 0) return true;

      // Broadcast: 255.255.255.255
      if (b0 === 255) return true;

      return false;
    }
    // Fail closed on invalid octal or IP quad notation (e.g., 010.08.0.1)
    if (rawParts.length <= 4 && rawParts.every((p) => /^[0-9a-fx]+$/i.test(p))) {
      return true;
    }
  }

  const ipType = isIP(cleanHost);

  if (ipType === 6 || cleanHost.includes(':')) {
    const full = cleanHost.toLowerCase();

    // IPv6 Loopback: ::1, ::
    if (full === '::1' || full === '::' || full === '0:0:0:0:0:0:0:1' || full === '0:0:0:0:0:0:0:0') {
      return true;
    }

    // Unique Local Address (ULA): fc00::/7 (fc00:: - fdff::)
    if (full.startsWith('fc') || full.startsWith('fd') || /^f[cd][0-9a-f]{2}:/i.test(full)) {
      return true;
    }

    // Link-local: fe80::/10 (fe80:: - febf::)
    if (/^fe[89ab]/i.test(full)) {
      return true;
    }

    // IPv4-mapped IPv6: ::ffff:127.0.0.1, ::ffff:0x7f.0.0.1, ::ffff:0177.0.0.1, ::ffff:7f00:1, 0:0:0:0:0:ffff:127.0.0.1, etc.
    const ipv4MappedMatch = full.match(/^(?:(?:::|0+:0+:0+:0+:0+:)ffff:)(.+)$/i);
    if (ipv4MappedMatch?.[1]) {
      const rest = ipv4MappedMatch[1];
      const hexWordsMatch = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
      if (hexWordsMatch?.[1] && hexWordsMatch?.[2]) {
        const h1 = parseInt(hexWordsMatch[1], 16);
        const h2 = parseInt(hexWordsMatch[2], 16);
        const b0 = (h1 >> 8) & 255;
        const b1 = h1 & 255;
        const b2 = (h2 >> 8) & 255;
        const b3 = h2 & 255;
        return isPrivateOrBlockedAddress(`${b0}.${b1}.${b2}.${b3}`);
      }
      return isPrivateOrBlockedAddress(rest);
    }

    if (ipType === 6) return false;
    return true; // Fail closed on malformed IPv6
  }

  return false;
};

export const validateEgressUrl = (
  rawUrl: string,
  allowedHosts?: readonly string[],
): URL => {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new Error('EGRESS_URL_REQUIRED');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('EGRESS_URL_MALFORMED');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('EGRESS_PROTOCOL_FORBIDDEN');
  }

  if (parsed.username || parsed.password) {
    throw new Error('EGRESS_CREDENTIALS_FORBIDDEN');
  }

  const hostname = parsed.hostname.toLowerCase();

  if (isPrivateOrBlockedAddress(hostname)) {
    throw new Error('SSRF_EGRESS_BLOCKED');
  }

  if (allowedHosts !== undefined && allowedHosts.length > 0) {
    const normalizedAllowed = allowedHosts.map((h) => h.toLowerCase().trim());
    if (!normalizedAllowed.includes(hostname)) {
      throw new Error('EGRESS_HOST_FORBIDDEN');
    }
  }

  return parsed;
};

/**
 * Safe outbound fetch wrapper enforcing SSRF and egress controls (FR-SEC-004).
 */
export const secureFetch = async (
  input: string | URL,
  init?: RequestInit,
  allowedHosts?: readonly string[],
): Promise<Response> => {
  const urlStr = typeof input === 'string' ? input : input.toString();
  validateEgressUrl(urlStr, allowedHosts);
  return fetch(urlStr, {
    ...init,
    redirect: 'manual',
  });
};

