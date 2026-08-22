<script lang="ts">
  let candidates: Array<{ id:string; assetId:string; funnelStage:string; riskState:string; score:number|null }> = $state([]);
  let why: unknown = $state(null);
  let selectedId: string | null = $state(null);
  let error: string | null = $state(null);
  const apiBase = '/api/v1';

  async function loadCandidates() {
    const r = await fetch(`${apiBase}/admin/candidates`);
    if (r.ok) { const j = await r.json() as { candidates: typeof candidates }; candidates = j.candidates; }
  }
  async function openWhy(id:string) {
    selectedId=id;
    const r = await fetch(`${apiBase}/admin/candidates/${id}/why-not-alerted`);
    if (!r.ok) { error=`why ${r.status}`; return; }
    const j = await r.json() as { whyNotAlerted: unknown };
    why = j.whyNotAlerted;
    error=null;
  }
  $effect(()=>{ loadCandidates(); });
</script>

<svelte:head><title>Candidate Radar — CIAG</title></svelte:head>

<section class="hero">
  <p class="eyebrow">ADMIN / CANDIDATE RADAR</p>
  <h1>Candidate Radar</h1>
  <p>Promotion funnel state per candidate. <strong>Why-not-alerted</strong> explains gating reason, missing evidence, risk block, or insufficient data with point-in-time references.</p>
  <a class="back" href="/admin">← Admin overview</a>
</section>

<div class="grid">
  <article class="panel">
    <h2>Funnel</h2>
    <table>
      <thead><tr><th>Candidate</th><th>Stage</th><th>Risk</th><th>Score</th><th>—</th></tr></thead>
      <tbody>
        {#each candidates as c (c.id)}
          <tr><td>{c.assetId}<br/><small>{c.id}</small></td><td><span class="pill">{c.funnelStage}</span></td><td>{c.riskState}</td><td>{c.score ?? '—'}</td><td><button onclick={()=>openWhy(c.id)}>why-not</button></td></tr>
        {/each}
      </tbody>
    </table>
  </article>

  <article class="panel">
    <h2>Why-not-alerted {#if selectedId}<small>{selectedId}</small>{/if}</h2>
    {#if error}<div class="err">{error}</div>{/if}
    {#if !why}<p class="muted">Select a candidate to see why it was not alerted. Explains one of: gating reason, missing evidence, risk block, or insufficient data — with point-in-time evidence references.</p>
    {:else}<pre>{JSON.stringify(why, null, 2)}</pre>{/if}
  </article>
</div>

<style>
  .hero{max-width:840px;margin-bottom:1.2rem}.eyebrow{color:#5dd6c0;font-size:.72rem;letter-spacing:.14em}.hero h1{font-size:2rem;color:#f1fbff}.hero p{color:#9eb4be;line-height:1.6}.back{color:#5dd6c0;text-decoration:none;font-size:.85rem}
  .grid{display:grid;grid-template-columns:1.2fr .9fr;gap:1rem}.panel{padding:1rem;border:1px solid #263b46;border-radius:10px;background:#0d1c25;overflow:auto}h2{font-size:.78rem;color:#88a2ae;text-transform:uppercase;letter-spacing:.06em}table{width:100%;border-collapse:collapse;font-size:.82rem}th{color:#8ba3af;text-align:left;font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;padding:.4rem;border-bottom:1px solid #1e3442}td{padding:.4rem;border-bottom:1px solid #132631;color:#d9e7ee}td small{color:#6b8594}.pill{background:#162a38;color:#8ec8ff;padding:.15rem .4rem;border-radius:99px;font-size:.7rem}button{padding:.3rem .5rem;border:1px solid #263b46;background:#0b1720;color:#cfe6f0;border-radius:6px;cursor:pointer}pre{font-size:.72rem;color:#cfe6f0;white-space:pre-wrap;word-break:break-word;background:#0b1720;padding:.6rem;border-radius:6px}.muted{color:#6b8594}.err{color:#ff8a8a}
  @media(max-width:900px){.grid{grid-template-columns:1fr}}
</style>
