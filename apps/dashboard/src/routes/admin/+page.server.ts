import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch }) => {
  const base = process.env.PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:3000';
  let overview: unknown = null;
  let incidents: unknown = null;
  let killSwitches: unknown = null;
  try {
    const r = await fetch(`${base}/api/v1/admin/overview`);
    if (r.ok) overview = await r.json();
  } catch { /* API unavailable */ }
  try {
    const r = await fetch(`${base}/api/v1/admin/incidents`);
    if (r.ok) incidents = await r.json();
  } catch { /* */ }
  try {
    const r = await fetch(`${base}/api/v1/admin/kill-switches`);
    if (r.ok) killSwitches = await r.json();
  } catch { /* */ }

  // This load MUST NOT trigger external provider calls — it only calls local admin overview.
  // The overview endpoint itself is guaranteed provider-free.

  return {
    overview: overview as
      | {
          systemMode: string;
          globalKillSwitchState: { name: string; enabled: boolean; enabledAt: string | null; reason: string | null }[];
          providerIncidents: {
            id: string;
            type: string;
            severity: string;
            owner: string;
            status: string;
            createdAt: string;
            affectedScopes: string[];
            automatedContainment: { action: string; success: boolean } | null;
            revalidationRequirements: string[];
          }[];
          quotaExhaustionForecast: { provider: string; remainingQuota: number; status: string; forecastDaysRemaining?: number | null }[];
          activeSchedules: { id: string; name: string; state: string; cron: string; timezone: string; paused: boolean }[];
          scheduleDrift: { scheduleId: string; driftDetected: boolean; driftType: string | null }[];
          workflowStates: { running: number; waiting: number; deadLettered: number; pending: number; completed: number; failed: number };
          candidateCounts: { byLifecycle: Record<string, number>; byRisk: Record<string, number>; total: number };
          lastBackupStatus: { tier: string; lastBackupAt: string | null; status: string; meetsRpo: boolean | null };
          generatedAt: string;
        }
      | null,
    incidents: incidents as { incidents: unknown[] } | null,
    killSwitches: killSwitches as { killSwitches: { name: string; enabled: boolean }[] } | null,
    generatedAt: new Date().toISOString(),
  };
};
