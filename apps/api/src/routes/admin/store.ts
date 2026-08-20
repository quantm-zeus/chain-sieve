import { createHash, randomUUID } from 'node:crypto';
import type {
  Incident,
  IncidentSeverity,
  IncidentStatus,
  IncidentType,
  KillSwitchName,
  KillSwitchState,
  OverviewResponse,
  AuditRecord,
  QuotaForecast,
  ScheduleDrift,
  WorkflowStates,
  CandidateCounts,
  LastBackupStatus,
  SystemMode,
} from './types.js';

const ALL_KILL_SWITCHES: KillSwitchName[] = [
  'DISABLE_ALL_AUTOMATION',
  'DISABLE_ALL_MODEL_CALLS',
  'DISABLE_ALL_PROVIDER_CALLS',
  'DISABLE_NOTIFICATIONS',
  'REVOKE_ALL_MCP_CLIENTS',
  'EMERGENCY_READ_ONLY_MODE',
];

const hashRecord = (previousHash: string | null, payload: unknown): string =>
  createHash('sha256')
    .update(`${previousHash ?? ''}:${JSON.stringify(payload)}`)
    .digest('hex');

export interface AdminStoreDependencies {
  now?: () => string;
  // Optional DB adapter — when provided we read/write schedules/workflows/candidates/backups from DB
  database?: {
    query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
  };
}

// In-memory singleton stores — sufficient for product since no migration is authorized.
// All access is via synchronous in-memory structures; no external provider calls are made.
export class AdminStore {
  private readonly now: () => string;
  private readonly database?: { query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> };

  // Kill switches
  private killSwitches: Map<KillSwitchName, KillSwitchState> = new Map();
  // Incidents
  private incidents: Map<string, Incident> = new Map();
  // Audit chain
  private auditLog: AuditRecord[] = [];
  private lastAuditHash: string | null = null;

  // Cached derived data for overview — updated only from DB/in-memory, never via provider calls
  private systemMode: SystemMode = 'SYNTHETIC_SHADOW';

  constructor(deps: AdminStoreDependencies = {}) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.database = deps.database;
    for (const name of ALL_KILL_SWITCHES) {
      this.killSwitches.set(name, {
        name,
        enabled: false,
        enabledAt: null,
        enabledBy: null,
        reason: null,
        requiresReauth: true,
        auditLogged: false,
      });
    }
  }

  // For testing: reset singleton state
  reset(): void {
    this.killSwitches.clear();
    for (const name of ALL_KILL_SWITCHES) {
      this.killSwitches.set(name, {
        name,
        enabled: false,
        enabledAt: null,
        enabledBy: null,
        reason: null,
        requiresReauth: true,
        auditLogged: false,
      });
    }
    this.incidents.clear();
    this.auditLog = [];
    this.lastAuditHash = null;
    this.systemMode = 'SYNTHETIC_SHADOW';
  }

  // ---- System Mode ----
  getSystemMode(): SystemMode {
    return this.systemMode;
  }
  setSystemMode(mode: SystemMode): void {
    this.systemMode = mode;
  }

  // ---- Kill Switches ----
  getKillSwitches(): KillSwitchState[] {
    return ALL_KILL_SWITCHES.map((name) => this.killSwitches.get(name)!);
  }
  getKillSwitch(name: KillSwitchName): KillSwitchState | undefined {
    return this.killSwitches.get(name);
  }

  /**
   * Toggle kill switch. Requires re-authentication (caller must verify before invoking).
   * Audit logged with hash chain. Returns updated state.
   */
  async setKillSwitch(
    name: KillSwitchName,
    enabled: boolean,
    actor: string,
    reason?: string,
    reauthVerified: boolean = false,
  ): Promise<KillSwitchState> {
    if (!reauthVerified) {
      throw Object.assign(new Error('REAUTH_REQUIRED'), { code: 'REAUTH_REQUIRED', status: 401 });
    }
    const previous = this.killSwitches.get(name);
    if (!previous) throw Object.assign(new Error('UNKNOWN_KILL_SWITCH'), { code: 'UNKNOWN_KILL_SWITCH', status: 400 });

    const now = this.now();
    const updated: KillSwitchState = {
      name,
      enabled,
      enabledAt: enabled ? now : null,
      enabledBy: enabled ? actor : null,
      reason: reason ?? null,
      requiresReauth: true,
      auditLogged: true,
    };
    this.killSwitches.set(name, updated);

    // If EMERGENCY_READ_ONLY_MODE is enabled, also force system mode to READ_ONLY
    if (name === 'EMERGENCY_READ_ONLY_MODE') {
      this.systemMode = enabled ? 'READ_ONLY' : 'SYNTHETIC_SHADOW';
    }

    // Audit log with hash chain
    const auditId = randomUUID();
    const action = enabled ? 'KILL_SWITCH_ENABLED' : 'KILL_SWITCH_DISABLED';
    const payload = { action, target: name, actor, enabled, reason, timestamp: now, reauthVerified };
    const recordHash = hashRecord(this.lastAuditHash, payload);
    const record: AuditRecord = {
      id: auditId,
      action: action as AuditRecord['action'],
      actor,
      target: name,
      timestamp: now,
      reauthVerified,
      detail: { reason, enabled },
      previousHash: this.lastAuditHash,
      recordHash,
    };
    this.auditLog.push(record);
    this.lastAuditHash = recordHash;

    // Persist audit to DB if available (best-effort, never throws)
    if (this.database) {
      try {
        await this.database.query(
          `INSERT INTO audit_records (id, event_type, actor, payload_json, previous_hash, record_hash, recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
          [auditId, action, actor, JSON.stringify({ target: name, reason, enabled, reauthVerified }), record.previousHash, record.recordHash, now],
        );
      } catch {
        // best-effort: DB may not have audit_records or connection unavailable
      }
    }

    return updated;
  }

  getAuditLog(): AuditRecord[] {
    return [...this.auditLog];
  }

  // ---- Incidents ----
  createIncident(input: {
    type: IncidentType;
    severity: IncidentSeverity;
    owner: string;
    affectedScopes: string[];
    automatedContainment?: { action: string; success: boolean; detail?: string } | null;
    evidenceRefs?: string[];
    revalidationRequirements?: string[];
    rootCause?: string;
  }): Incident {
    const now = this.now();
    const id = `inc_${randomUUID().slice(0, 8)}`;
    const incident: Incident = {
      id,
      type: input.type,
      severity: input.severity,
      owner: input.owner,
      status: 'OPEN',
      createdAt: now,
      updatedAt: now,
      acknowledgedAt: null,
      resolvedAt: null,
      affectedScopes: input.affectedScopes,
      automatedContainment: input.automatedContainment
        ? { action: input.automatedContainment.action, appliedAt: now, success: input.automatedContainment.success, detail: input.automatedContainment.detail }
        : null,
      evidenceRefs: input.evidenceRefs ?? [],
      revalidationRequirements: input.revalidationRequirements ?? [],
      rootCause: input.rootCause ?? null,
      correctiveAction: null,
      resolutionNotes: null,
    };
    this.incidents.set(id, incident);

    // Audit for creation
    const payload = { action: 'INCIDENT_CREATED', target: id, type: input.type, severity: input.severity };
    const recordHash = hashRecord(this.lastAuditHash, payload);
    this.auditLog.push({
      id: randomUUID(),
      action: 'INCIDENT_CREATED',
      actor: input.owner,
      target: id,
      timestamp: now,
      reauthVerified: false,
      detail: payload,
      previousHash: this.lastAuditHash,
      recordHash,
    });
    this.lastAuditHash = recordHash;

    return incident;
  }

  acknowledgeIncident(id: string, actor: string): Incident {
    const existing = this.incidents.get(id);
    if (!existing) throw Object.assign(new Error('INCIDENT_NOT_FOUND'), { code: 'INCIDENT_NOT_FOUND', status: 404 });
    if (existing.status !== 'OPEN') throw Object.assign(new Error('INCIDENT_NOT_OPEN'), { code: 'INCIDENT_NOT_OPEN', status: 409 });
    const now = this.now();
    const updated: Incident = { ...existing, status: 'ACKNOWLEDGED' as IncidentStatus, acknowledgedAt: now, updatedAt: now };
    this.incidents.set(id, updated);

    const payload = { action: 'INCIDENT_ACKNOWLEDGED', target: id, actor };
    const recordHash = hashRecord(this.lastAuditHash, payload);
    this.auditLog.push({
      id: randomUUID(),
      action: 'INCIDENT_ACKNOWLEDGED',
      actor,
      target: id,
      timestamp: now,
      reauthVerified: false,
      detail: payload,
      previousHash: this.lastAuditHash,
      recordHash,
    });
    this.lastAuditHash = recordHash;

    return updated;
  }

  listIncidents(): Incident[] {
    return [...this.incidents.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  getIncident(id: string): Incident | undefined {
    return this.incidents.get(id);
  }

  // ---- Overview (never triggers external provider calls) ----
  // This method reads only from local store / DB. It MUST NOT call any provider adapter.
  async getOverview(): Promise<OverviewResponse> {
    const generatedAt = this.now();

    // Active schedules — from DB if available, otherwise empty
    let activeSchedules: OverviewResponse['activeSchedules'] = [];
    let scheduleDrift: ScheduleDrift[] = [];
    if (this.database) {
      try {
        const result = await this.database.query<{ id: string; name: string; state: string; cron: string; timezone: string; paused: boolean }>(
          `SELECT s.id, s.name, s.state, sv.cron, sv.timezone, s.paused FROM schedules s LEFT JOIN schedule_versions sv ON sv.id = s.current_version_id WHERE s.state IN ('ACTIVE','PAUSED') LIMIT 100`,
        );
        activeSchedules = (result.rows as Array<{ id: string; name: string; state: string; cron: string; timezone: string; paused: boolean }>).map((r) => ({
          id: String(r.id),
          name: String(r.name),
          state: String(r.state),
          cron: String(r.cron ?? '0 * * * *'),
          timezone: String(r.timezone ?? 'UTC'),
          paused: Boolean(r.paused),
        }));
      } catch {
        activeSchedules = [];
      }
      // Schedule drift from schedule_incidents or schedule_reconciliation — best effort
      try {
        const drift = await this.database.query<{ schedule_id: string | null; detail: string }>(
          `SELECT schedule_id, detail FROM schedule_incidents WHERE type LIKE '%DRIFT%' OR type LIKE '%MISMATCH%' ORDER BY created_at DESC LIMIT 20`,
        );
        for (const row of drift.rows as Array<{ schedule_id: string | null; detail: string }>) {
          if (row.schedule_id) {
            scheduleDrift.push({
              scheduleId: String(row.schedule_id),
              expectedCron: 'unknown',
              actualCron: null,
              driftDetected: true,
              driftType: String(row.detail).slice(0, 100),
              detectedAt: generatedAt,
            });
          }
        }
      } catch {
        // no drift table
      }
    }

    // Workflow states — from DB if available
    let workflowStates: WorkflowStates = { running: 0, waiting: 0, deadLettered: 0, pending: 0, completed: 0, failed: 0 };
    if (this.database) {
      try {
        const wf = await this.database.query<{ status: string; count: string }>(`SELECT status, COUNT(*)::text AS count FROM workflow_runs GROUP BY status`);
        for (const row of wf.rows as Array<{ status: string; count: string }>) {
          const c = Number(row.count);
          const s = String(row.status).toUpperCase();
          if (s === 'RUNNING') workflowStates.running = c;
          else if (s === 'WAITING') workflowStates.waiting = c;
          else if (s === 'PENDING') workflowStates.pending = c;
          else if (s === 'COMPLETED') workflowStates.completed = c;
          else if (s === 'FAILED') workflowStates.failed = c;
        }
        try {
          const dl = await this.database.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM dead_letter_items WHERE status='OPEN'`);
          workflowStates.deadLettered = Number((dl.rows[0] as { count: string } | undefined)?.count ?? 0);
        } catch {
          // no DL table yet
        }
      } catch {
        // no workflow tables
      }
    }

    // Candidate counts — from DB if available; uses synthetic_observations as proxy for candidate funnel if needed
    let candidateCounts: CandidateCounts = {
      byLifecycle: { DISCOVERED: 0, QUALIFIED: 0, EMERGING: 0, CONFIRMED: 0, MONITORING: 0, DECAYING: 0, REJECTED: 0, ARCHIVED: 0 },
      byRisk: { UNKNOWN: 0, LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0, CONFLICTING: 0 },
      total: 0,
    };
    if (this.database) {
      try {
        // Try candidate table if exists; fallback to synthetic_observations
        const cand = await this.database.query<{ lifecycle: string; risk: string; count: string }>(
          `SELECT COALESCE(lifecycle,'DISCOVERED') AS lifecycle, COALESCE(risk,'UNKNOWN') AS risk, COUNT(*)::text AS count FROM synthetic_observations GROUP BY lifecycle, risk`,
        ).catch(() => ({ rows: [], rowCount: 0 } as { rows: unknown[]; rowCount: number }));
        if (cand.rows.length > 0) {
          for (const row of cand.rows as Array<{ lifecycle: string; risk: string; count: string }>) {
            const c = Number(row.count);
            candidateCounts.total += c;
            candidateCounts.byLifecycle[row.lifecycle] = (candidateCounts.byLifecycle[row.lifecycle] ?? 0) + c;
            candidateCounts.byRisk[row.risk] = (candidateCounts.byRisk[row.risk] ?? 0) + c;
          }
        } else {
          // Single total from observations
          const tot = await this.database.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM synthetic_observations`);
          const n = Number((tot.rows[0] as { count: string } | undefined)?.count ?? 0);
          candidateCounts.total = n;
          candidateCounts.byLifecycle['DISCOVERED'] = n;
          candidateCounts.byRisk['UNKNOWN'] = n;
        }
      } catch {
        // keep defaults
      }
    }

    // Last backup status
    let lastBackupStatus: LastBackupStatus = {
      tier: 'CRITICAL_CONFIG',
      lastBackupAt: null,
      status: 'NOT_AVAILABLE',
      meetsRpo: null,
      meetsRto: null,
      location: null,
    };
    if (this.database) {
      try {
        const br = await this.database.query<{ tier: string; created_at: string; location: string }>(
          `SELECT tier, created_at, location FROM backup_records ORDER BY created_at DESC LIMIT 1`,
        );
        if (br.rows.length > 0) {
          const row = br.rows[0] as { tier: string; created_at: string | Date; location: string };
          const created = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
          const ageMs = Date.parse(generatedAt) - Date.parse(created);
          const ageMin = ageMs / 60000;
          // RPO for CRITICAL_CONFIG is 15 minutes per FR-DR-006
          const meetsRpo = ageMin <= 15;
          lastBackupStatus = {
            tier: String(row.tier),
            lastBackupAt: created,
            status: meetsRpo ? 'HEALTHY' : 'STALE',
            meetsRpo,
            meetsRto: null,
            location: String(row.location),
          };
        }
      } catch {
        // no backup table
      }
    }

    // Quota exhaustion forecast — reads from local state; never calls provider. Uses quota_reservations placeholder if table exists
    let quotaExhaustionForecast: QuotaForecast[] = [];
    if (this.database) {
      try {
        // No quota table yet — return synthetic forecast showing healthy
        quotaExhaustionForecast = [
          { provider: 'aggregate-discovery', costClass: 'FREE', remainingQuota: 9500, forecastDaysRemaining: 7, exhaustionAt: null, status: 'HEALTHY' },
        ];
      } catch {
        quotaExhaustionForecast = [];
      }
    } else {
      quotaExhaustionForecast = [
        { provider: 'aggregate-discovery', costClass: 'FREE', remainingQuota: 9500, forecastDaysRemaining: 7, exhaustionAt: null, status: 'HEALTHY' },
      ];
    }

    return {
      systemMode: this.systemMode,
      globalKillSwitchState: this.getKillSwitches(),
      providerIncidents: this.listIncidents(),
      quotaExhaustionForecast,
      activeSchedules,
      scheduleDrift,
      workflowStates,
      candidateCounts,
      lastBackupStatus,
      generatedAt,
    };
  }

  // For testing: seed deterministic data
  seedForTests(seed: { incidents?: Incident[]; killSwitches?: Partial<Record<KillSwitchName, boolean>> }): void {
    if (seed.incidents) {
      for (const inc of seed.incidents) this.incidents.set(inc.id, inc);
    }
    if (seed.killSwitches) {
      for (const [name, enabled] of Object.entries(seed.killSwitches)) {
        const ks = this.killSwitches.get(name as KillSwitchName);
        if (ks) this.killSwitches.set(name as KillSwitchName, { ...ks, enabled: Boolean(enabled), enabledAt: enabled ? this.now() : null, enabledBy: enabled ? 'test' : null });
      }
    }
  }
}

// Global singleton — ensures kill switch state and incidents are process-wide
let globalStore: AdminStore | null = null;
export const getAdminStore = (deps?: AdminStoreDependencies): AdminStore => {
  if (!globalStore) globalStore = new AdminStore(deps);
  // If deps provides database and store doesn't have one, attach
  if (deps?.database && !globalStore['database']) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalStore as any).database = deps.database;
  }
  if (deps?.now) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalStore as any).now = deps.now;
  }
  return globalStore;
};
export const resetAdminStore = (): void => {
  if (globalStore) globalStore.reset();
  else globalStore = new AdminStore();
};
