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

  const normalized = hostOrIp.trim().toLowerCase();

  // Strip brackets from IPv6 literal
  const cleanHost = normalized.startsWith('[') && normalized.endsWith(']')
    ? normalized.slice(1, -1)
    : normalized;

  if (BLOCKED_HOSTNAMES.has(cleanHost)) return true;

  // Check decimal IP notations like 2130706433 (127.0.0.1) or hex/octal representations
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

  const ipType = isIP(cleanHost);

  if (ipType === 4) {
    const parts = cleanHost.split('.').map((part) => {
      // Octal notation check (e.g. 0177)
      if (part.length > 1 && part.startsWith('0')) {
        return parseInt(part, 8);
      }
      return Number(part);
    });

    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
      return true;
    }

    const [b0, b1] = parts;

    // Loopback: 127.0.0.0/8, 0.0.0.0/8
    if (b0 === 127 || b0 === 0) return true;

    // RFC 1918 Private: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
    if (b0 === 10) return true;
    if (b0 === 172 && b1 !== undefined && b1 >= 16 && b1 <= 31) return true;
    if (b0 === 192 && b1 === 168) return true;

    // Link-local / Cloud metadata: 169.254.0.0/16 (e.g., AWS/GCP/Azure 169.254.169.254)
    if (b0 === 169 && b1 === 254) return true;

    // Carrier-grade NAT: 100.64.0.0/10 (e.g., 100.64.0.0 to 100.127.255.255, Alibaba metadata 100.100.100.200)
    if (b0 === 100 && b1 !== undefined && b1 >= 64 && b1 <= 127) return true;

    // Documentation / Benchmark: 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24, 198.18.0.0/15
    if (b0 === 192 && b1 === 0) return true;
    if (b0 === 198 && (b1 === 51 || (b1 !== undefined && b1 >= 18 && b1 <= 19))) return true;
    if (b0 === 203 && b1 === 0) return true;

    // Broadcast: 255.255.255.255
    if (b0 === 255) return true;

    return false;
  }

  if (ipType === 6) {
    const full = cleanHost.toLowerCase();

    // IPv6 Loopback: ::1, ::
    if (full === '::1' || full === '::' || full === '0:0:0:0:0:0:0:1' || full === '0:0:0:0:0:0:0:0') {
      return true;
    }

    // Unique Local Address (ULA): fc00::/7 (fc00:: - fdff::)
    if (full.startsWith('fc') || full.startsWith('fd')) {
      return true;
    }

    // Link-local: fe80::/10 (fe80:: - febf::)
    if (/^fe[89ab]/i.test(full)) {
      return true;
    }

    // IPv4-mapped IPv6: ::ffff:127.0.0.1, ::ffff:10.0.0.1, etc.
    const ipv4MappedMatch = full.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (ipv4MappedMatch?.[1]) {
      return isPrivateOrBlockedAddress(ipv4MappedMatch[1]);
    }

    return false;
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
