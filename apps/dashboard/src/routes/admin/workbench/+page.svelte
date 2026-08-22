<script lang="ts">
  let sessions: Array<{ id: string; status: string; createdAt: string }> = $state([]);
  let selected: { id: string; status: string; events: Array<{ sequence:number; eventTime:string; type:string; evidenceIds:string[]; evidenceLinks:string[]; latencyMs?:number; provider?:string }>; toolTimeline: unknown[]; cancellation: unknown; abort: unknown } | null = $state(null);
  let error: string | null = $state(null);
  let loading = $state(false);

  const apiBase = '/api/v1';

  async function loadSessions() {
    loading = true; error = null;
    try {
      const r = await fetch(`${apiBase}/admin/agent/sessions`);
      if (!r.ok) throw new Error(`sessions ${r.status}`);
      const j = await r.json() as { sessions: typeof sessions };
      sessions = j.sessions;
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    loading = false;
  }
  async function createSession() {
    const r = await fetch(`${apiBase}/admin/agent/sessions`, { method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify({ agentProfileId:'ap_v1', modelProfileId:'mp_v1', promptVersion:'v1', toolProfileVersion:'tp_v1' }) });
    if (r.ok) await loadSessions();
  }
  async function openSession(id: string) {
    const r = await fetch(`${apiBase}/admin/agent/sessions/${id}`);
    if (r.ok) {
      const j = await r.json() as { session: typeof selected };
      selected = j.session;
    }
  }
  async function cancelSession(id: string) {
    await fetch(`${apiBase}/admin/agent/sessions/${id}/cancel`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ reason:'user cancelled' }) });
    await openSession(id); await loadSessions();
  }

  $effect(() => { loadSessions(); });
</script>

<svelte:head><title>Agent Workbench — CIAG</title></svelte:head>

<section class="hero">
  <p class="eyebrow">ADMIN / RESEARCH WORKBENCH</p>
  <h1>Agent Workbench</h1>
  <p>Streaming reasoning steps and tool timeline ordered by <em>event time</em>. Each entry links evidence; cancellation and abort are explicitly visible.</p>
  <a class="back" href="/admin">← Admin overview</a>
</section>

<div class="toolbar">
  <button onclick={createSession}>New session</button>
  <button onclick={loadSessions} disabled={loading}>Refresh</button>
  {#if error}<span class="err">{error}</span>{/if}
</div>

<div class="grid">
  <article class="panel">
    <h2>Sessions</h2>
    {#if sessions.length===0}<p class="muted">No sessions yet.</p>{:else}
      <ul class="list">
        {#each sessions as s (s.id)}
          <li><button class="link" onclick={()=>openSession(s.id)}>{s.id} — {s.status} <small>{new Date(s.createdAt).toLocaleString()}</small></button> <button onclick={()=>cancelSession(s.id)}>cancel</button></li>
        {/each}
      </ul>
    {/if}
  </article>

  <article class="panel">
    <h2>Tool timeline <span class="badge">event-time ordered</span></h2>
    {#if !selected}<p class="muted">Select a session.</p>
    {:else}
      {#if selected.cancellation}<div class="alert cancel">Cancelled: {JSON.stringify(selected.cancellation)}</div>{/if}
      {#if selected.abort}<div class="alert abort">Aborted: {JSON.stringify(selected.abort)}</div>{/if}
      <ol class="timeline">
        {#each selected.events as ev (ev.sequence)}
          <li class="ev" data-type={ev.type}>
            <span class="seq">#{ev.sequence}</span>
            <span class="type">{ev.type}</span>
            <time>{new Date(ev.eventTime).toISOString()}</time>
            {#if ev.evidenceLinks.length>0}
              <span class="evidence">evidence: {#each ev.evidenceLinks as l, i}<a href={l}>{ev.evidenceIds[i]}</a>{/each}</span>
            {/if}
            {#if ev.latencyMs!==undefined}<span class="lat">{ev.latencyMs}ms</span>{/if}
            {#if ev.provider}<span class="prov">{ev.provider}</span>{/if}
          </li>
        {/each}
      </ol>
      <details><summary>Raw tool timeline</summary><pre>{JSON.stringify(selected.toolTimeline, null, 2)}</pre></details>
    {/if}
  </article>
</div>

<style>
  .hero{max-width:840px;margin-bottom:1.5rem}.eyebrow{color:#5dd6c0;font-size:.72rem;letter-spacing:.14em}.hero h1{font-size:2rem;margin:.3rem 0 .4rem;color:#f1fbff}.hero p{color:#9eb4be;line-height:1.6}.back{color:#5dd6c0;text-decoration:none;font-size:.85rem}
  .subnav{display:flex;gap:.6rem;margin-top:.6rem}.subnav a{color:#8ec8ff;font-size:.8rem;text-decoration:none;border:1px solid #1e3442;padding:.25rem .5rem;border-radius:6px}
  .toolbar{display:flex;gap:.6rem;align-items:center;margin:1rem 0}button{padding:.4rem .7rem;border:1px solid #263b46;background:#0d1c25;color:#cfe6f0;border-radius:6px;cursor:pointer}.err{color:#ff8a8a;font-size:.8rem}
  .grid{display:grid;grid-template-columns:1fr 1.6fr;gap:1rem}.panel{padding:1rem;border:1px solid #263b46;border-radius:10px;background:#0d1c25}h2{font-size:.78rem;color:#88a2ae;text-transform:uppercase;letter-spacing:.06em;margin:0 0 .6rem}.badge{font-size:.6rem;background:#1e3a4a;color:#8ec8ff;border-radius:99px;padding:.15rem .4rem}
  .muted{color:#6b8594;font-size:.85rem}.list{list-style:none;padding:0;display:grid;gap:.4rem}.link{background:none;border:none;color:#8ec8ff;cursor:pointer;text-align:left}.timeline{list-style:none;padding:0;display:grid;gap:.35rem}.ev{display:flex;gap:.5rem;align-items:center;font-size:.78rem;color:#cfe6f0;padding:.4rem .5rem;background:#0b1720;border:1px solid #1e3442;border-radius:6px}.seq{color:#6b8594}.type{font-weight:600}.ev time{color:#6b8594;font-size:.7rem}.evidence a{color:#5dd6c0}.alert{padding:.5rem;border-radius:6px;font-size:.8rem;margin-bottom:.6rem}.alert.cancel{background:#1a1608;border:1px solid #6b5a1a;color:#f5c86a}.alert.abort{background:#1a0e0e;border:1px solid #6b2a2a;color:#ff8a8a}
  @media(max-width:900px){.grid{grid-template-columns:1fr}}
</style>
