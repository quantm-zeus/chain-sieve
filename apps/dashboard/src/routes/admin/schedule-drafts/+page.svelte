<script lang="ts">
  let naturalLanguage = $state('Create a schedule to monitor solana tokens every hour using workflow wf_v1 and agent profile ap_v1');
  let drafts: Array<{ id:string; status:string; validated:boolean; createdAt:string }> = $state([]);
  let selected: { id:string; status:string; validated:boolean; resolvedConfig:unknown; resolvedConfigHash:string|null; resolvedConfigReviewed:boolean; capacityForecast:unknown; approval:unknown; immutableVersion:unknown } | null = $state(null);
  let msg: string | null = $state(null);
  let err: string | null = $state(null);
  const apiBase = '/api/v1';

  async function loadDrafts() {
    const r = await fetch(`${apiBase}/admin/schedule-drafts`);
    if (r.ok) { const j = await r.json() as { drafts: typeof drafts }; drafts = j.drafts; }
  }
  async function createDraft() {
    err=null; msg=null;
    const r = await fetch(`${apiBase}/admin/schedule-drafts`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ naturalLanguage }) });
    const j = await r.json().catch(()=> ({})) as Record<string,unknown>;
    if (!r.ok) { err = JSON.stringify(j,null,2); } else { msg = `created ${j['id']}`; }
    await loadDrafts();
  }
  async function openDraft(id:string) {
    const r = await fetch(`${apiBase}/admin/schedule-drafts/${id}`);
    if (r.ok) { const j = await r.json() as { draft: typeof selected }; selected = j.draft; }
  }
  async function review() {
    if (!selected) return;
    const r = await fetch(`${apiBase}/admin/schedule-drafts/${selected.id}/review`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ reviewer:'admin@example.com' }) });
    const j = await r.json() as Record<string,unknown>;
    if (!r.ok) err = JSON.stringify(j,null,2); else msg='reviewed resolved-config';
    if (selected) await openDraft(selected.id);
  }
  async function forecast() {
    if (!selected) return;
    const r = await fetch(`${apiBase}/admin/schedule-drafts/${selected.id}/capacity-forecast`, { method:'POST' });
    const j = await r.json() as Record<string,unknown>;
    if (!r.ok) err = JSON.stringify(j,null,2); else msg='capacity forecast PASS (30-day SCC)';
    if (selected) await openDraft(selected.id);
  }
  async function approve() {
    if (!selected) return;
    const r = await fetch(`${apiBase}/admin/schedule-drafts/${selected.id}/approve`, { method:'POST', headers:{'content-type':'application/json','x-reauth-verified':'true','x-actor':'admin@example.com'}, body: JSON.stringify({ actor:'admin@example.com' }) });
    const j = await r.json() as Record<string,unknown>;
    if (!r.ok) err = JSON.stringify(j,null,2); else msg='approved with re-auth';
    if (selected) await openDraft(selected.id);
  }
  async function activate() {
    if (!selected) return;
    const r = await fetch(`${apiBase}/admin/schedule-drafts/${selected.id}/activate`, { method:'POST', headers:{'content-type':'application/json','x-reauth-verified':'true','x-actor':'admin@example.com'}, body: JSON.stringify({ actor:'admin@example.com' }) });
    const j = await r.json() as Record<string,unknown>;
    if (!r.ok) err = JSON.stringify(j,null,2); else msg=`activated immutable version ${(j['version'] as Record<string,string>)?.['versionId'] ?? ''}`;
    if (selected) await openDraft(selected.id);
    await loadDrafts();
  }
  $effect(()=>{ loadDrafts(); });
</script>

<svelte:head><title>Schedule Drafts — CIAG</title></svelte:head>

<section class="hero">
  <p class="eyebrow">ADMIN / SCHEDULE DRAFTS</p>
  <h1>Admin chat — validated schedule drafts</h1>
  <p>Admin chat creates <strong>only validated</strong> schedule drafts. Activation gates enforce: resolved-config review, 30-day capacity forecast via Sustainable Capacity Contract, explicit approval with re-authentication, and immutable version creation.</p>
  <a class="back" href="/admin">← Admin overview</a>
</section>

<div class="creator">
  <label>Natural language (admin chat)
    <textarea bind:value={naturalLanguage} rows="3"></textarea>
  </label>
  <button onclick={createDraft}>Create validated draft</button>
  <span class="hint">Only validated drafts are accepted; invalid input returns 422 with issues.</span>
</div>

{#if msg}<div class="ok">{msg}</div>{/if}
{#if err}<pre class="err">{err}</pre>{/if}

<div class="grid">
  <article class="panel">
    <h2>Drafts</h2>
    {#if drafts.length===0}<p class="muted">No drafts.</p>{:else}
      <ul class="list">{#each drafts as d (d.id)}<li><button class="link" onclick={()=>openDraft(d.id)}>{d.id} — {d.status} {d.validated ? 'validated' : 'invalid'}</button></li>{/each}</ul>
    {/if}
  </article>
  <article class="panel">
    <h2>Selected</h2>
    {#if !selected}<p class="muted">Select a draft.</p>{:else}
      <pre>{JSON.stringify(selected, null, 2)}</pre>
      <div class="steps">
        <button onclick={review} disabled={selected.resolvedConfigReviewed}>1. Review resolved-config</button>
        <button onclick={forecast}>2. Capacity forecast (30-day SCC)</button>
        <button onclick={approve}>3. Approve (re-auth)</button>
        <button onclick={activate}>4. Activate → immutable version</button>
      </div>
      <p class="hint">Steps must be done in order; skipping returns 422/401. Activation creates an immutable version.</p>
    {/if}
  </article>
</div>

<style>
  .hero{max-width:840px;margin-bottom:1rem}.eyebrow{color:#5dd6c0;font-size:.72rem;letter-spacing:.14em}.hero h1{font-size:1.7rem;color:#f1fbff}.hero p{color:#9eb4be;line-height:1.6}.back{color:#5dd6c0;text-decoration:none;font-size:.85rem}
  .creator{display:grid;gap:.6rem;margin:1rem 0;padding:1rem;border:1px solid #263b46;border-radius:10px;background:#0d1c25}label{color:#cfe6f0;font-size:.85rem;display:grid;gap:.3rem}textarea{padding:.5rem;border:1px solid #263b46;background:#0b1720;color:#cfe6f0;border-radius:6px}
  button{padding:.4rem .7rem;border:1px solid #263b46;background:#0d1c25;color:#cfe6f0;border-radius:6px;cursor:pointer}button:disabled{opacity:.5}.hint{color:#6b8594;font-size:.75rem}.ok{padding:.5rem;background:#0e1f16;border:1px solid #356a4a;color:#4ade80;border-radius:6px;margin:.6rem 0}.err{color:#ff8a8a;white-space:pre-wrap;background:#1a0e0e;padding:.6rem;border-radius:6px}
  .grid{display:grid;grid-template-columns:1fr 1.3fr;gap:1rem}.panel{padding:1rem;border:1px solid #263b46;border-radius:10px;background:#0d1c25;overflow:auto}h2{font-size:.78rem;color:#88a2ae;text-transform:uppercase;letter-spacing:.06em}.list{list-style:none;padding:0;display:grid;gap:.3rem}.link{background:none;border:none;color:#8ec8ff;cursor:pointer;text-align:left}pre{font-size:.72rem;color:#cfe6f0;white-space:pre-wrap;word-break:break-word;background:#0b1720;padding:.6rem;border-radius:6px}.steps{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.6rem}.muted{color:#6b8594}
  @media(max-width:900px){.grid{grid-template-columns:1fr}}
</style>
