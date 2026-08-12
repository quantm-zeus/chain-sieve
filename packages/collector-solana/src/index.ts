import { resolveProtocolSupport, listSupportedProtocols } from '@ciag/collector-core';

export function getSolanaProtocolRegistry() {
  return listSupportedProtocols().filter((p) => ['pump', 'raydium', 'orca', 'meteora', 'jupiter'].includes(p.program));
}

export function assertSolanaReadOnlyCoverage(program: string, version: string, design: string) {
  const support = resolveProtocolSupport(program, version, design);
  if (support.status === 'UNSUPPORTED') {
    return { status: 'UNSUPPORTED' as const, reason: `unsupported ${program} ${version} ${design}`, manifest: support };
  }
  return { status: support.status, manifest: support };
}
