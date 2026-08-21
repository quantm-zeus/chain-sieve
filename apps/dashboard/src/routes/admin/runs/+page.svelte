<script lang="ts">
  let runs: Array<{ id:string; frozenAt:string }> = $state([]);
  let investigation: { frozenSnapshot: unknown; reEvaluation: unknown; plannerEnvelope: unknown; validatedClaims: unknown; evidenceIds: string[]; budgets: unknown } | null = $state(null);
  let inputRunId = $state('');
  let error: string | null = $state(null);
  const apiBase = '/api/v1';

  async function createRun() {
    const r = await fetch(`${apiBase}/admin/runs`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({}) });
    if (r.ok) {
      const j = await r.json() as { snapshot:{ runId:string }};
      inputRunId = j.snapshot.runId;
      await openInvestigation(j.snapshot.runId);
    }
  }
  async function openInvestigation(id:string) {
    error=null;
    const r = await fetch(`${apiBase}/admin/runs/${id}/investigation`);
    if (!r.ok) { error=`run ${r.status}`; return; }
    const j = await r.json() as { investigation: typeof investigation };
    investigation = j.investigation;
  }
  async function reEvaluate() {
    if (!inputRunId) return;
    const r = await fetch(`${apiBase}/admin/runs/${inputRunId}/re-evaluate`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ evidenceIds:['ev_new_1'], claims:['liquidity improved','new risk flag'] }) });
    if (r.ok) await openInvestigation(inputRunId);
  }
</script>

<svelte:head><title>Frozen Run Investigation — CIAG</title></svelte:head>

<section class="hero">
  <p class="eyebrow">ADMIN / FROZEN INVESTIGATION</p>
  <h1>Frozen-run investigation</h1>
  <p>Immutable run snapshot: planner envelope, validated claims, evidence IDs, budgets. Original explanation stays frozen; current re-evaluation is shown separately with diff.</p>
  <a class="back" href="/admin">← Admin overview</a>
</section>

<div class="toolbar">
  <button onclick={createRun}>Create demo run</button>
  <input bind:value={inputRunId} placeholder="run id" />
  <button onclick={()=> openInvestigation(inputRunId)}>Open</button>
  <button onclick={reEvaluate}>Re-evaluate with current data</button>
</div>
{#if error}<div class="err">{error}</div>{/if}

{#if investigation}
  <div class="grid">
    <article class="panel frozen">
      <h2>Frozen explanation <span class="badge">immutable</span></h2>
      <pre>{JSON.stringify(investigation.frozenSnapshot, null, 2)}</pre>
      <h3>Planner envelope</h3><pre>{JSON.stringify(investigation.plannerEnvelope, null, 2)}</pre>
      <h3>Validated claims</h3><pre>{JSON.stringify(investigation.validatedClaims, null, 2)}</pre>
      <h3>Evidence IDs</h3><div class="chips">{#each investigation.evidenceIds as e}<a class="chip" href={`/api/v1/admin/evidence/${e}`}>{e}</a>{/each}</div>
      <h3>Budgets</h3><pre>{JSON.stringify(investigation.budgets, null, 2)}</pre>
    </article>
    <article class="panel current">
      <h2>Current re-evaluation</h2>
      {#if !investigation.reEvaluation}<p class="muted">No re-evaluation yet. Frozen view did not fetch current provider data.</p>{:else}<pre>{JSON.stringify(investigation.reEvaluation, null, 2)}</pre>{/if}
    </article>
  </div>
{:else}
  <p class="muted">No investigation loaded. Create or open a run.</p>
{/if}

<style>
  .hero{max-width:840px;margin-bottom:1.2rem}.eyebrow{color:#5dd6c0;font-size:.72rem;letter-spacing:.14em}.hero h1{font-size:2rem;color:#f1fbff}.hero p{color:#9eb4be;line-height:1.6}.back{color:#5dd6c0;text-decoration:none;font-size:.85rem}
  .toolbar{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin:1rem 0}button{padding:.4rem .7rem;border:1px solid #263b46;background:#0d1c25;color:#cfe6f0;border-radius:6px;cursor:pointer}input{padding:.4rem .5rem;border:1px solid #263b46;background:#0b1720;color:#cfe6f0;border-radius:6px}.err{color:#ff8a8a}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem}.panel{padding:1rem;border:1px solid #263b46;border-radius:10px;background:#0d1c25;overflow:auto}h2{font-size:.78rem;color:#88a2ae;text-transform:uppercase;letter-spacing:.06em}.badge{background:#1e3a4a;color:#8ec8ff;border-radius:99px;padding:.15rem .4rem;font-size:.6rem}pre{font-size:.72rem;color:#cfe6f0;white-space:pre-wrap;word-break:break-word;background:#0b1720;padding:.6rem;border-radius:6px}.chips{display:flex;flex-wrap:wrap;gap:.3rem}.chip{font-size:.7rem;background:#0b1720;border:1px solid #1e3442;color:#8ec8ff;padding:.2rem .4rem;border-radius:99px;text-decoration:none}.muted{color:#6b8594}
  @media(max-width:900px){.grid{grid-template-columns:1fr}}
</style>
