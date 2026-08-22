<script lang="ts">
  let { data } = $props();
  const overview = $derived(data.overview);
  const killMap = $derived(
    new Map((overview?.globalKillSwitchState ?? []).map((k: { name: string; enabled: boolean }) => [k.name, k.enabled])),
  );
</script>

<svelte:head><title>Admin Overview — CIAG</title></svelte:head>

<section class="hero">
  <p class="eyebrow">ADMIN / OBSERVABILITY</p>
  <h1>Operational overview</h1>
  <p>System mode, kill switches, incidents, schedules, workflows and backup — refreshed from local cache only.</p>
  <nav class="subnav" aria-label="Workbench sections">
    <a href="/admin/workbench">Workbench</a>
    <a href="/admin/runs">Frozen Runs</a>
    <a href="/admin/candidates">Candidate Radar</a>
    <a href="/admin/schedule-drafts">Schedule Drafts</a>
  </nav>
  <a class="back" href="/">← Bootstrap</a>
</section>

{#if !overview}
  <div class="notice">Admin API unavailable — showing empty overview (no provider calls).</div>
{:else}
  <section class="kpis">
    <article class="kpi mode"><h2>System mode</h2><strong class:alert={overview.systemMode === 'READ_ONLY'}>{overview.systemMode}</strong><p>Global capability mode</p></article>
    <article class="kpi"><h2>Active schedules</h2><strong>{overview.activeSchedules.length}</strong><p>Schedule drift: {overview.scheduleDrift.filter((d: { driftDetected: boolean }) => d.driftDetected).length} detected</p></article>
    <article class="kpi"><h2>Workflows</h2><strong>{overview.workflowStates.running} running</strong><p>{overview.workflowStates.waiting} waiting · {overview.workflowStates.deadLettered} dead-lettered</p></article>
    <article class="kpi"><h2>Candidates</h2><strong>{overview.candidateCounts.total}</strong><p>By lifecycle / risk</p></article>
    <article class="kpi"><h2>Last backup</h2><strong>{overview.lastBackupStatus.status}</strong><p>{overview.lastBackupStatus.lastBackupAt ?? 'no backup'} · RPO {overview.lastBackupStatus.meetsRpo === true ? 'OK' : overview.lastBackupStatus.meetsRpo === false ? 'BREACH' : '—'}</p></article>
  </section>

  <section class="grid">
    <article class="panel kill-switches">
      <h2>Global kill switches <span class="badge">reauth required · audit logged</span></h2>
      <div class="switch-list">
        {#each overview.globalKillSwitchState as ks (ks.name)}
          <div class="switch-row" class:enabled={ks.enabled}>
            <span class="name">{ks.name}</span>
            <span class="state">{ks.enabled ? 'ENABLED' : 'DISABLED'}</span>
            <span class="dot" aria-hidden="true"></span>
          </div>
        {/each}
      </div>
      <p class="hint">Toggling any switch requires re-authentication and creates an audit record.</p>
    </article>

    <article class="panel">
      <h2>Quota exhaustion forecast</h2>
      {#if overview.quotaExhaustionForecast.length === 0}
        <p class="muted">No quota data</p>
      {:else}
        <table>
          <thead><tr><th>Provider</th><th>Remaining</th><th>Forecast</th><th>Status</th></tr></thead>
          <tbody>
            {#each overview.quotaExhaustionForecast as q (q.provider)}
              <tr><td>{q.provider}</td><td>{q.remainingQuota}</td><td>{q.forecastDaysRemaining ?? '—'} d</td><td><span class="pill" data-status={q.status}>{q.status}</span></td></tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </article>
  </section>

  <section class="grid">
    <article class="panel">
      <h2>Provider incidents</h2>
      {#if overview.providerIncidents.length === 0}
        <p class="muted">No active incidents</p>
      {:else}
        <ul class="incidents">
          {#each overview.providerIncidents as inc (inc.id)}
            <li class="incident" data-severity={inc.severity}>
              <div class="inc-head"><strong>{inc.type}</strong><span class="severity">{inc.severity}</span><span class="status">{inc.status}</span></div>
              <div class="meta">Owner: {inc.owner} · {new Date(inc.createdAt).toLocaleString()} · Scopes: {inc.affectedScopes.join(', ') || '—'}</div>
              {#if inc.automatedContainment}
                <div class="containment">Containment: {inc.automatedContainment.action} · {inc.automatedContainment.success ? 'applied' : 'pending'}</div>
              {/if}
              {#if inc.revalidationRequirements.length > 0}
                <div class="reval">Revalidation: {inc.revalidationRequirements.join('; ')}</div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </article>

    <article class="panel">
      <h2>Active schedules &amp; drift</h2>
      {#if overview.activeSchedules.length === 0}
        <p class="muted">No active schedules</p>
      {:else}
        <table>
          <thead><tr><th>Schedule</th><th>Cron</th><th>State</th></tr></thead>
          <tbody>
            {#each overview.activeSchedules as s (s.id)}
              <tr><td>{s.name}<br /><small>{s.id}</small></td><td>{s.cron} <small>({s.timezone})</small></td><td>{s.paused ? 'PAUSED' : s.state}</td></tr>
            {/each}
          </tbody>
        </table>
      {/if}
      {#if overview.scheduleDrift.length > 0}
        <div class="drift">
          <strong>Drift detected</strong>
          <ul>{#each overview.scheduleDrift as d (d.scheduleId)}<li>{d.scheduleId}: {d.driftType ?? 'unknown'}</li>{/each}</ul>
        </div>
      {/if}
    </article>
  </section>

  <section class="grid">
    <article class="panel">
      <h2>Workflow states</h2>
      <div class="bars">
        {#each Object.entries(overview.workflowStates) as [k, v] (k)}<div class="bar-row"><span>{k}</span><strong>{v as number}</strong></div>{/each}
      </div>
    </article>
    <article class="panel">
      <h2>Candidate counts</h2>
      <h3>Lifecycle</h3>
      <div class="chips">{#each Object.entries(overview.candidateCounts.byLifecycle) as [k, v] (k)}<span class="chip">{k}: {v as number}</span>{/each}</div>
      <h3>Risk</h3>
      <div class="chips">{#each Object.entries(overview.candidateCounts.byRisk) as [k, v] (k)}<span class="chip risk">{k}: {v as number}</span>{/each}</div>
    </article>
  </section>

  <p class="timestamp">Overview generated {overview.generatedAt} · Refresh never calls external providers</p>
{/if}

<style>
  .hero{max-width:780px;margin-bottom:2rem}.eyebrow{color:#5dd6c0;font-size:.75rem;letter-spacing:.16em}.hero h1{font-size:clamp(2rem,5vw,3.2rem);margin:.4rem 0 .6rem;color:#f1fbff}.hero p{color:#9eb4be;line-height:1.6}.back{display:inline-block;margin-top:.8rem;color:#5dd6c0;text-decoration:none;font-size:.85rem}
  .notice{padding:1rem;border:1px solid #805b22;background:#1a1508;color:#ffbf69;border-radius:8px}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1rem;margin:1.5rem 0}
  .kpi{padding:1rem;border:1px solid #263b46;border-radius:10px;background:linear-gradient(145deg,#0d1c25,#0a151d)}h2{font-size:.78rem;color:#88a2ae;text-transform:uppercase;letter-spacing:.07em;margin:0 0 .6rem} .kpi strong{font-size:1.35rem;color:#e8f7fa}.kpi strong.alert{color:#ff6b6b} .kpi p{color:#849ba6;font-size:.82rem;margin:.4rem 0 0}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:1rem;margin-top:1rem}
  .panel{padding:1.1rem;border:1px solid #263b46;border-radius:10px;background:#0d1c25}
  .badge{font-size:.65rem;background:#1e3a4a;color:#8ec8ff;border-radius:99px;padding:.2rem .5rem;margin-left:.4rem;letter-spacing:.02em}
  .switch-list{display:grid;gap:.4rem;margin:.6rem 0}
  .switch-row{display:flex;align-items:center;gap:.6rem;padding:.55rem .7rem;border-radius:8px;background:#0b1720;border:1px solid #1e3442;font-size:.82rem}.switch-row.enabled{border-color:#356a4a;background:#0e1f16}
  .switch-row .name{flex:1;font-family:ui-monospace,monospace;color:#d9e7ee;letter-spacing:.02em}.switch-row .state{font-size:.72rem;color:#8ba3af}.switch-row.enabled .state{color:#4ade80}
  .dot{width:.55rem;height:.55rem;border-radius:50%;background:#4a5568}.switch-row.enabled .dot{background:#22c55e;box-shadow:0 0 8px #22c55e66}
  .hint{color:#6b8594;font-size:.75rem;margin-top:.6rem}
  table{width:100%;border-collapse:collapse;font-size:.84rem}th{color:#8ba3af;text-align:left;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;padding:.4rem .3rem;border-bottom:1px solid #1e3442}td{padding:.45rem .3rem;border-bottom:1px solid #132631;color:#d9e7ee}td small{color:#6b8594}
  .pill{padding:.15rem .45rem;border-radius:99px;font-size:.7rem;background:#162a38;color:#8ec8ff}.pill[data-status='WARNING']{background:#2a2410;color:#f5c86a}.pill[data-status='EXHAUSTED']{background:#2e1515;color:#ff8a8a}
  .muted{color:#6b8594;font-size:.85rem}
  .incidents{list-style:none;padding:0;margin:0;display:grid;gap:.6rem}.incident{padding:.7rem .8rem;border-radius:8px;background:#0b1720;border:1px solid #1e3442;border-left:3px solid #3a5a6a}.incident[data-severity='CRITICAL']{border-left-color:#ef4444}.incident[data-severity='HIGH']{border-left-color:#f59e0b}.inc-head{display:flex;gap:.5rem;align-items:center;font-size:.84rem}.severity{font-size:.68rem;padding:.15rem .4rem;border-radius:99px;background:#162a38;color:#9ecbff}.status{margin-left:auto;font-size:.7rem;color:#8ba3af}.meta{font-size:.75rem;color:#6b8594;margin-top:.25rem}.containment,.reval{font-size:.75rem;color:#9eb4be;margin-top:.25rem}
  .drift{margin-top:.8rem;padding:.6rem;background:#0b1720;border-radius:8px;border:1px solid #1e3442;font-size:.8rem}.drift ul{margin:.3rem 0 0 .9rem}
  .bars{display:grid;gap:.35rem}.bar-row{display:flex;justify-content:space-between;font-size:.84rem;color:#cfe6f0}.bar-row span{color:#8ba3af}
  .chips{display:flex;flex-wrap:wrap;gap:.4rem;margin:.4rem 0 .8rem}.chip{background:#0b1720;border:1px solid #1e3442;color:#cfe6f0;padding:.25rem .5rem;border-radius:99px;font-size:.74rem}.chip.risk{border-color:#2a3442}
  .timestamp{margin-top:1.5rem;color:#637a84;font-size:.75rem}
</style>
