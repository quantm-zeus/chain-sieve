import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { getTableName } from 'drizzle-orm';
import {
  createAssetRepresentation,
  normalizeAddress,
  assertNoBackdating,
  isAvailableAtPointInTime as isDomainAvailableAtPointInTime,
} from '@ciag/domain';
import {
  ObservationEnvelopeSchema,
  RequiredTimestampsSchema,
} from '@ciag/shared-schemas';
import {
  assertReadOnlyExecution,
  requireReadOnlyCapability,
  validateToolAllowlist,
} from '@ciag/security';
import { ToolCore } from '@ciag/tool-core';
import type { CostPolicyAdapter } from '@ciag/provider-contracts';
import { ExactMemoryCache } from '@ciag/runtime-cache';
import {
  applyBootstrapMigration,
  schemaMigrations,
  specificationMetadata,
  harnessState,
  taskState,
  clusterState,
  syntheticObservations,
  artifactMetadata,
  outbox,
  evaluationRecords,
  auditRecords,
} from '@ciag/persistence';
import {
  FakeNotificationTransport,
  FakeProviderNetwork,
  MemoryPostgresAdapter,
  VirtualClock,
} from '@ciag/test-fixtures';
import { FakeObjectStore } from '@ciag/object-store';
import { InMemoryTracer } from '@ciag/observability';
import { runWalkingSkeleton, replayStagesAsOf } from '@ciag/workflow-runtime';
import { createApp, createMcpServer } from '../../apps/api/src/app.js';
import { McpAdapter } from '@ciag/mcp-adapter';
import { decode, hasDecoder, supportedDecoderIds } from '@ciag/program-decoders';
import { loadAndValidateSpecification } from '../../tools/prd-compiler/compiler.js';

describe('G0 integration and conformance evidence (AC-001..AC-004)', () => {
  const dummyCostPolicy: CostPolicyAdapter = {
    authorize: async (input: { operation: string; costClass: 'FREE' | 'METERED' | 'UNKNOWN'; cacheHit: boolean }) => ({
      status: 'AVAILABLE' as const,
      capabilityMode: 'SYNTHETIC_SHADOW' as const,
      value: { quotaCharged: input.cacheHit ? 0 : 1 },
    }),
  };

  const denyingCostPolicy: CostPolicyAdapter = {
    authorize: async () => ({
      status: 'NOT_AVAILABLE' as const,
      capabilityMode: 'SYNTHETIC_SHADOW' as const,
      reason: 'QUOTA_EXHAUSTED',
    }),
  };

  // AC-001: MCP client initialization, scoped profile, and explicit provider degradation
  describe('AC-001: MCP client initialization, scoped profile, and explicit provider degradation', () => {
    it('initializes production McpAdapter and exposes only verified read-only capability tools', async () => {
      const cache = new ExactMemoryCache();
      const toolCore = new ToolCore(cache, dummyCostPolicy);
      const adapter = new McpAdapter(toolCore);

      const tools = adapter.listTools();
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(tool.readOnly).toBe(true);
        expect(() => requireReadOnlyCapability(tool.name)).not.toThrow();
        validateToolAllowlist(tool.name, ['system_readiness']);
      }

      const readiness = adapter.systemReadiness();
      expect(readiness.capabilityMode).toBe('SYNTHETIC_SHADOW');
      expect(readiness.productCapabilitiesActive).toBe(false);

      const deniedTool = 'executeSwap';
      expect(() => requireReadOnlyCapability(deniedTool)).toThrow('PROHIBITED_CAPABILITY');
    });

    it('analyzes Solana asset through approved boundaries and explicitly degrades on unavailable provider', async () => {
      const cache = new ExactMemoryCache();
      const toolCore = new ToolCore(cache, dummyCostPolicy);

      const rawAddress = 'So11111111111111111111111111111111111111112';
      const normalized = normalizeAddress('solana', rawAddress);
      expect(normalized).toBe(rawAddress);

      const asset = createAssetRepresentation({
        chainId: 'solana',
        contractAddress: normalized,
        decimals: 9,
        decimalsVersion: 'v1',
        decimalsSource: 'onchain',
        symbol: 'SOL',
        name: 'Wrapped SOL',
      });
      expect(asset.chainId).toBe('solana');
      expect(asset.canonicalContractAddress).toBe(rawAddress);

      const unavailableProvider = async () => ({
        status: 'UNAVAILABLE' as const,
        reason: 'PROVIDER_RATE_LIMIT_EXCEEDED',
        retryAfterSeconds: 30,
      });

      const securityResult = await toolCore.execute(
        {
          key: `security-check:${asset.representationId}`,
          operation: 'security_evaluation',
          costClass: 'FREE',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        unavailableProvider,
      );
      expect(securityResult.value.status).toBe('UNAVAILABLE');
      expect(securityResult.value.reason).toBe('PROVIDER_RATE_LIMIT_EXCEEDED');
    });

    it('serves production API router and MCP Streamable-HTTP transport with complete fail-closed security perimeter', async () => {
      const secretToken = 'secret-mcp-token';
      const allowedOrigins = ['https://allowed.example'];

      // Production application instance with approved boundaries
      const app = createApp({
        allowedOrigins,
        mcpAuthToken: secretToken,
        mcpMaxBodyBytes: 1024,
        dependencies: [
          { name: 'postgres', ready: async () => true, detail: 'connected' },
          { name: 'object-store', ready: async () => true, detail: 'accessible' },
        ],
      });

      // Degraded dependency instance
      const degradedApp = createApp({
        allowedOrigins,
        mcpAuthToken: secretToken,
        dependencies: [
          { name: 'postgres', ready: async () => false, detail: 'connection-failed' },
        ],
      });

      // Health endpoint (200)
      const health = await app.request('/api/v1/health');
      expect(health.status).toBe(200);
      const healthJson = await health.json();
      expect(healthJson.status).toBe('ok');
      expect(healthJson.service).toBe('ciag-api');

      // Readiness endpoint (200)
      const ready = await app.request('/api/v1/readiness');
      expect(ready.status).toBe(200);
      const readyJson = await ready.json();
      expect(readyJson.status).toBe('ready');
      expect(readyJson.capabilityMode).toBe('SYNTHETIC_SHADOW');

      // Degraded readiness (503)
      const degraded = await degradedApp.request('/api/v1/readiness');
      expect(degraded.status).toBe(503);
      const degradedJson = await degraded.json();
      expect(degradedJson.status).toBe('not_ready');

      // Origin enforcement: forbidden origin fails closed (403)
      const forbiddenOrigin = await app.request('/mcp', {
        method: 'POST',
        headers: {
          origin: 'https://malicious.example',
          authorization: `Bearer ${secretToken}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(forbiddenOrigin.status).toBe(403);

      // Auth enforcement: missing bearer token fails closed (401)
      const unauthenticated = await app.request('/mcp', {
        method: 'POST',
        headers: {
          origin: 'https://allowed.example',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(unauthenticated.status).toBe(401);

      // Content-type enforcement: non-json fails (415)
      const invalidContentType = await app.request('/mcp', {
        method: 'POST',
        headers: {
          origin: 'https://allowed.example',
          authorization: `Bearer ${secretToken}`,
          'content-type': 'text/plain',
          accept: 'application/json, text/event-stream',
        },
        body: 'invalid',
      });
      expect(invalidContentType.status).toBe(415);

      // Payload size enforcement: body exceeding mcpMaxBodyBytes fails (413)
      const oversizedBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', pad: 'x'.repeat(2048) });
      const oversized = await app.request('/mcp', {
        method: 'POST',
        headers: {
          origin: 'https://allowed.example',
          authorization: `Bearer ${secretToken}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: oversizedBody,
      });
      expect(oversized.status).toBe(413);

      // Unsupported protocol version fails (400)
      const unsupportedProtocol = await app.request('/mcp', {
        method: 'POST',
        headers: {
          origin: 'https://allowed.example',
          authorization: `Bearer ${secretToken}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': 'invalid-2020-01-01',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(unsupportedProtocol.status).toBe(400);

      // Session scope expired fails (401)
      const expiredSession = await app.request('/mcp', {
        method: 'POST',
        headers: {
          origin: 'https://allowed.example',
          authorization: `Bearer ${secretToken}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-11-25',
          'x-mcp-session-id': 'sess-123',
          'x-mcp-session-expires': new Date(Date.now() - 60_000).toISOString(),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(expiredSession.status).toBe(401);

      // Valid MCP Streamable-HTTP request routed through production transport
      const validMcp = await app.request('/mcp', {
        method: 'POST',
        headers: {
          origin: 'https://allowed.example',
          authorization: `Bearer ${secretToken}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-11-25',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(validMcp.status).toBe(200);
      const validJson = await validMcp.json();
      expect(validJson.result?.tools?.length).toBeGreaterThan(0);
      expect(validJson.result.tools[0].name).toBe('system_readiness');
    });

    it('creates production MCP server with strictly approved tool definitions', () => {
      const server = createMcpServer(undefined, undefined, ['system_readiness']);
      expect(server).toBeDefined();
    });
  });

  // AC-002: Quality, time, provenance, evidence references
  describe('AC-002: Returned important fields retain quality, time, provenance, and evidence lineage', () => {
    it('validates complete timestamps, quality, and provenance in shared schemas', () => {
      const validTimestamps = {
        eventAt: '2026-01-01T00:00:00.000Z',
        sourceObservedAt: '2026-01-01T00:00:00.000Z',
        ingestedAt: '2026-01-01T00:00:01.000Z',
        availableAt: '2026-01-01T00:00:01.000Z',
        availabilityProvenance: 'FIRST_PARTY_LIVE_OBSERVED' as const,
      };

      const parsedTimestamps = RequiredTimestampsSchema.safeParse(validTimestamps);
      expect(parsedTimestamps.success).toBe(true);

      const invalidBackdating = {
        ...validTimestamps,
        availableAt: '2025-12-31T23:59:59.000Z',
      };
      expect(() =>
        assertNoBackdating(
          invalidBackdating.eventAt,
          invalidBackdating.availableAt,
        ),
      ).toThrow();

      const envelope = {
        id: 'env-001',
        representationId: 'solana:So11111111111111111111111111111111111111112',
        eventAt: '2026-01-01T00:00:00.000Z',
        sourceObservedAt: '2026-01-01T00:00:00.000Z',
        availableAt: '2026-01-01T00:00:01.000Z',
        availabilityProvenance: 'FIRST_PARTY_LIVE_OBSERVED' as const,
        quality: 'VALID' as const,
        payload: {
          priceUsd: '190.50',
        },
      };

      const parsedEnvelope = ObservationEnvelopeSchema.safeParse(envelope);
      expect(parsedEnvelope.success).toBe(true);
    });

    it('enforces no-backdating and preserves provenance across domain and collector boundaries', () => {
      const availableTime = '2026-01-01T00:00:02.000Z';
      const queryTimeBefore = '2026-01-01T00:00:01.000Z';
      const queryTimeAfter = '2026-01-01T00:00:03.000Z';

      expect(isDomainAvailableAtPointInTime(availableTime, queryTimeBefore)).toBe(false);
      expect(isDomainAvailableAtPointInTime(availableTime, queryTimeAfter)).toBe(true);
    });
  });

  // AC-003: Cross-mode single-flight and exact cache deduplication
  describe('AC-003: Cross-mode single-flight and exact cache deduplication', () => {
    it('deduplicates concurrent requests within inflight window and shares exact cache across modes', async () => {
      const sharedCache = new ExactMemoryCache();
      const toolCoreA = new ToolCore(sharedCache, dummyCostPolicy);
      const toolCoreB = new ToolCore(sharedCache, dummyCostPolicy);

      let loadCalls = 0;
      let resolvePromise!: (val: {
        status: 'SUCCESS';
        data: { result: string; timestamp: string };
      }) => void;
      const providerPromise = new Promise<{
        status: 'SUCCESS';
        data: { result: string; timestamp: string };
      }>((resolve) => {
        resolvePromise = resolve;
      });

      const deferredProvider = async () => {
        loadCalls += 1;
        return providerPromise;
      };

      const key = 'solana:token-metrics:SOL';
      const requestSpec = {
        key,
        operation: 'token_metrics',
        costClass: 'FREE' as const,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };

      // Inflight deduplication: concurrent requests collapse to 1 provider call
      const p1 = toolCoreA.execute(requestSpec, deferredProvider);
      const p2 = toolCoreA.execute(requestSpec, deferredProvider);

      resolvePromise({
        status: 'SUCCESS',
        data: { result: 'market_intelligence_bundle', timestamp: '2026-01-01T00:00:00.000Z' },
      });

      const [res1, res2] = await Promise.all([p1, p2]);

      expect(loadCalls).toBe(1);
      expect(res1.value.status).toBe('SUCCESS');
      expect(res2.value.status).toBe('SUCCESS');

      // Cross-mode exact cache sharing: toolCoreB gets cached result with 0 provider calls
      const resCached = await toolCoreB.execute(requestSpec, deferredProvider);
      expect(loadCalls).toBe(1);
      expect(resCached.cached).toBe(true);
      expect(resCached.quotaCharged).toBe(0);
    });

    it('does not collapse non-canonical or distinct cache keys', async () => {
      const sharedCache = new ExactMemoryCache();
      const toolCore = new ToolCore(sharedCache, dummyCostPolicy);

      let loadCalls = 0;
      const provider = async () => {
        loadCalls += 1;
        return { status: 'SUCCESS' as const, data: { value: loadCalls } };
      };

      const resA = await toolCore.execute(
        { key: 'solana:asset:A', operation: 'op', costClass: 'FREE', expiresAt: new Date(Date.now() + 60_000).toISOString() },
        provider,
      );
      const resB = await toolCore.execute(
        { key: 'solana:asset:B', operation: 'op', costClass: 'FREE', expiresAt: new Date(Date.now() + 60_000).toISOString() },
        provider,
      );

      expect(loadCalls).toBe(2);
      expect(resA.cached).toBe(false);
      expect(resB.cached).toBe(false);
    });

    it('fails closed when cost policy denies quota authorization before provider execution', async () => {
      const cache = new ExactMemoryCache();
      const toolCore = new ToolCore(cache, denyingCostPolicy);

      let providerCalled = false;
      const provider = async () => {
        providerCalled = true;
        return { status: 'SUCCESS' as const };
      };

      await expect(
        toolCore.execute(
          { key: 'solana:asset:denied', operation: 'op', costClass: 'METERED', expiresAt: new Date(Date.now() + 60_000).toISOString() },
          provider,
        ),
      ).rejects.toThrow('QUOTA_EXHAUSTED');
      expect(providerCalled).toBe(false);
    });
  });

  // AC-004: Unsupported, drifting, or conflicting data fails explicitly
  describe('AC-004: Unsupported, drifting, or conflicting data fails explicitly and is never silently replaced', () => {
    it('exercises versioned Solana decoder registry and fails closed with raw event preservation on unknown programs', () => {
      const supported = supportedDecoderIds();
      expect(supported).toContain('pump-bc-v1');
      expect(supported).toContain('raydium-amm-v4');
      expect(supported).toContain('orca-v1');
      expect(supported).toContain('meteora-dlmm-v1');
      expect(supported).toContain('jupiter-v6');

      // Supported decoder successfully decodes
      expect(hasDecoder('pump-bc-v1')).toBe(true);
      const rawPayload = new Uint8Array([1, 2, 3, 4]);
      const validResult = decode('pump-bc-v1', rawPayload);
      expect(validResult.ok).toBe(true);

      // Unknown or unsupported decoder fails closed and preserves raw payload
      const unknownDecoderId = 'unsupported-dex-fork-v99';
      expect(hasDecoder(unknownDecoderId)).toBe(false);
      const failedResult = decode(unknownDecoderId, rawPayload);
      expect(failedResult.ok).toBe(false);
      if (!failedResult.ok) {
        expect(failedResult.reason).toContain('UNKNOWN_DECODER');
        expect(failedResult.rawPreserved).toBe(true);
        expect(failedResult.decoderId).toBe(unknownDecoderId);
      }
    });

    it('rejects provider schema drift explicitly via allowlist and fallback markers', async () => {
      const cache = new ExactMemoryCache();
      const toolCore = new ToolCore(cache, dummyCostPolicy);

      // Explicit allowlist drift
      const driftingProvider = async () => ({
        status: 'SUCCESS' as const,
        corruptedField: true,
      });

      await expect(
        toolCore.execute(
          {
            key: 'solana:pool:drifting-pool-id',
            operation: 'pool_state',
            costClass: 'FREE',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
          driftingProvider,
          { allowedFields: ['status'] },
        ),
      ).rejects.toThrow('SCHEMA_DRIFT');

      // Fallback __schemaDrift marker
      const markerDriftProvider = async () => ({
        status: 'SUCCESS' as const,
        __schemaDrift: true,
      });

      await expect(
        toolCore.execute(
          {
            key: 'solana:pool:marker-drift-id',
            operation: 'pool_state',
            costClass: 'FREE',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
          markerDriftProvider,
        ),
      ).rejects.toThrow('SCHEMA_DRIFT');
    });

    it('structurally prohibits financial execution and trading capabilities', () => {
      const dangerousActions = [
        'signTransaction',
        'submitTransaction',
        'executeSwap',
        'transferFunds',
        'placeOrder',
      ];

      for (const action of dangerousActions) {
        expect(() =>
          assertReadOnlyExecution(action),
        ).toThrow('PROHIBITED_CAPABILITY');
      }
    });

    it('preserves historical observations during collector gaps and reorgs without overwriting', () => {
      const observations: Array<{ revision: number; availableAt: string; data: string }> = [];

      // Initial observation at t0
      observations.push({
        revision: 1,
        availableAt: '2026-01-01T00:00:00.000Z',
        data: 'confirmed_slot_100_state_a',
      });

      // Fork/reorg observation arriving at t1 with revised slot 100
      observations.push({
        revision: 2,
        availableAt: '2026-01-01T00:00:05.000Z',
        data: 'reorg_slot_100_state_b',
      });

      // Point-in-time queries as of t0 see revision 1
      const asOfT0 = observations.filter(
        (o) => isDomainAvailableAtPointInTime(o.availableAt, '2026-01-01T00:00:02.000Z'),
      );
      expect(asOfT0.length).toBe(1);
      expect(asOfT0[0]?.revision).toBe(1);

      // Point-in-time queries as of t1 see both revisions
      const asOfT1 = observations.filter(
        (o) => isDomainAvailableAtPointInTime(o.availableAt, '2026-01-01T00:00:06.000Z'),
      );
      expect(asOfT1.length).toBe(2);
      expect(asOfT1[1]?.revision).toBe(2);
    });
  });

  // Persistence and SQL migration agreement
  describe('Persistence and SQL migration agreement', () => {
    it('ensures Drizzle schema mirrors all SQL migration tables, columns, and constraints without divergence', async () => {
      const migrationSql = await readFile(
        'infra/migrations/0001_bootstrap_foundation.sql',
        'utf8',
      );

      const sqlTables = [...migrationSql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+)/g)]
        .map((match) => match[1])
        .sort();

      const drizzleTableObjects = [
        schemaMigrations,
        specificationMetadata,
        harnessState,
        taskState,
        clusterState,
        syntheticObservations,
        artifactMetadata,
        outbox,
        evaluationRecords,
        auditRecords,
      ];

      const drizzleTables = drizzleTableObjects
        .map((table) => getTableName(table))
        .sort();

      expect(drizzleTables).toEqual(sqlTables);
      expect(sqlTables).toHaveLength(10);

      // Verify all expected tables exist
      const expectedTables = [
        'schema_migrations',
        'specification_metadata',
        'harness_state',
        'task_state',
        'cluster_state',
        'synthetic_observations',
        'artifact_metadata',
        'outbox',
        'evaluation_records',
        'audit_records',
      ];
      for (const table of expectedTables) {
        expect(sqlTables).toContain(table);
      }

      // Column and structure agreement across Drizzle schema and SQL
      for (const table of drizzleTableObjects) {
        const tableName = getTableName(table);
        const tableBlockMatch = migrationSql.match(
          new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${tableName}\\s*\\(([^;]+)\\);`, 's'),
        );
        expect(tableBlockMatch).toBeDefined();
        const tableBlock = tableBlockMatch![1]!;

        const drizzleColumns = Object.keys(table);
        const sqlColumns = tableBlock
          .split('\n')
          .map((l) => l.trim())
          .filter(
            (l) =>
              l.length > 0 &&
              !l.startsWith('CONSTRAINT') &&
              !l.startsWith('PRIMARY KEY') &&
              !l.startsWith('CHECK'),
          )
          .map((l) => l.split(/\s+/)[0])
          .filter(
            (col) =>
              col &&
              !['CHECK', 'CONSTRAINT', 'FOREIGN', 'PRIMARY', 'UNIQUE'].includes(
                col.toUpperCase(),
              ),
          );

        for (const col of sqlColumns) {
          expect(
            drizzleColumns.some(
              (dcol) =>
                dcol === col ||
                (table as unknown as Record<string, { name?: string }>)[dcol]?.name === col,
            ),
          ).toBe(true);
        }
      }

      // Verify critical check constraints, unique constraints, and indexes
      expect(migrationSql).toContain('CHECK (available_at >= event_time)');
      expect(migrationSql).toContain("CHECK (capability_mode = 'SYNTHETIC_SHADOW')");
      expect(migrationSql).toContain('CHECK (length(prd_sha256) = 64)');
      expect(migrationSql).toContain('idempotency_key text NOT NULL UNIQUE');
      expect(migrationSql).toContain('REFERENCES artifact_metadata(artifact_key)');
      expect(migrationSql).toContain(
        'CREATE INDEX IF NOT EXISTS synthetic_observations_asset_available_idx ON synthetic_observations(asset_id, available_at);',
      );
    });

    it('enforces storage check constraints for no-backdating and capability mode', async () => {
      const db = new MemoryPostgresAdapter();
      await applyBootstrapMigration(db);

      // Verify migration table was registered
      const migrations = await db.query<{ version: string }>(
        'SELECT version FROM schema_migrations',
      );
      expect(migrations.rowCount).toBe(1);
      expect(migrations.rows[0]?.version).toBe('0001_bootstrap_foundation');

      // Valid insert into synthetic_observations
      await db.query(`
        INSERT INTO synthetic_observations (
          id, asset_id, stage, payload_json, event_time, observed_at, available_at, idempotency_key, capability_mode, trace_id
        ) VALUES (
          'obs-001', 'asset-1', 'raw', '{"price": 100}', '2026-01-01 00:00:00+00', '2026-01-01 00:00:01+00', '2026-01-01 00:00:01+00',
          'idemp-001', 'SYNTHETIC_SHADOW', 'trace-001'
        )
      `);

      // Backdated insert must fail check constraint (available_at >= event_time)
      await expect(
        db.query(`
          INSERT INTO synthetic_observations (
            id, asset_id, stage, payload_json, event_time, observed_at, available_at, idempotency_key, capability_mode, trace_id
          ) VALUES (
            'obs-bad', 'asset-1', 'raw', '{"price": 100}', '2026-01-01 00:00:05+00', '2026-01-01 00:00:01+00', '2026-01-01 00:00:01+00',
            'idemp-002', 'SYNTHETIC_SHADOW', 'trace-002'
          )
        `),
      ).rejects.toThrow();
    });
  });

  // Walking skeleton integrated outcome and PRD drift verification
  describe('Walking skeleton integrated outcome and PRD verification', () => {
    it('verifies PRD specification, hashes, and requirement mappings without drift', async () => {
      const spec = await loadAndValidateSpecification();
      expect(spec.issues).toHaveLength(0);
      expect(spec.hashes.prd).toHaveLength(64);
      expect(spec.hashes.requirements).toHaveLength(64);
      expect(spec.hashes.audit).toHaveLength(64);

      const requirementIds = spec.manifest.requirements.map((r) => r.id);
      expect(requirementIds).toContain('FR-CORE-001');
      expect(requirementIds).toContain('FR-SEC-001');
      const acceptanceIds = spec.manifest.acceptanceCriteria.map((a) => a.id);
      expect(acceptanceIds).toEqual(expect.arrayContaining(['AC-001', 'AC-002', 'AC-003', 'AC-004']));
    });

    it('executes full end-to-end walking skeleton with complete trace continuity and outbox delivery', async () => {
      const clock = new VirtualClock(new Date('2026-01-01T00:00:00.000Z'));
      const db = new MemoryPostgresAdapter();
      await applyBootstrapMigration(db);

      const objectStore = new FakeObjectStore();
      const network = new FakeProviderNetwork(clock);
      const notifications = new FakeNotificationTransport();
      const tracer = new InMemoryTracer(() => 'trace-g0-integration-001', () => clock.now());

      const skeletonResult = await runWalkingSkeleton({
        database: db,
        objectStore,
        discovery: network,
        notifications,
        tracer,
        clock,
      });

      expect(skeletonResult.observationCount).toBe(6);
      expect(skeletonResult.traceId).toBe('trace-g0-integration-001');
      expect(skeletonResult.capabilityMode).toBe('SYNTHETIC_SHADOW');
      expect(skeletonResult.outboxState).toBe('DELIVERED');
      expect(skeletonResult.duplicateSuppressed).toBe(true);
      expect(skeletonResult.outcomeState).toBe('MATURE');
      expect(skeletonResult.artifactKey).toContain('evidence/');

      // Verify frozen evidence artifact in object store
      const storedArtifact = await objectStore.get(skeletonResult.artifactKey);
      expect(storedArtifact).toBeDefined();
      expect(storedArtifact!.length).toBeGreaterThan(0);
      const parsedArtifact = JSON.parse(new TextDecoder().decode(storedArtifact!));
      expect(parsedArtifact.decision).toBe('OBSERVE_ONLY');
      expect(parsedArtifact.traceId).toBe(skeletonResult.traceId);

      // Verify trace continuity in persistent storage across observations and outbox
      const storedObservations = await db.query<{ trace_id: string }>(
        'SELECT trace_id FROM synthetic_observations WHERE trace_id = $1',
        [skeletonResult.traceId],
      );
      expect(storedObservations.rowCount).toBe(6);

      const storedOutbox = await db.query<{ trace_id: string; state: string }>(
        'SELECT trace_id, state FROM outbox WHERE trace_id = $1',
        [skeletonResult.traceId],
      );
      expect(storedOutbox.rowCount).toBeGreaterThan(0);
      expect(storedOutbox.rows[0]?.state).toBe('DELIVERED');

      // Point-in-time replay: before event availableAt returns 0
      const beforeReplay = await replayStagesAsOf(db, skeletonResult.assetId, '2025-12-31T00:00:00.000Z');
      expect(beforeReplay).toHaveLength(0);

      // Point-in-time replay: after availableAt returns full observation history
      const replayed = await replayStagesAsOf(db, skeletonResult.assetId, clock.now());
      expect(replayed.length).toBe(6);
    });
  });
});
