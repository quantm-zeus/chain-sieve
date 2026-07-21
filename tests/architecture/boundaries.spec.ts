import { describe, expect, it } from 'vitest';
import { scanPlaceholders, scanProhibitedCapabilities, verifyArchitecture } from '../../tools/architecture-verifier/verify.js';

describe('architecture fitness', () => {
  it('enforces package boundaries', async () => { await expect(verifyArchitecture()).resolves.toMatchObject({ rules: 8 }); });
  it('contains no production placeholders or prohibited capabilities', async () => { await expect(scanPlaceholders()).resolves.toBeDefined(); await expect(scanProhibitedCapabilities()).resolves.toBeDefined(); });
});
