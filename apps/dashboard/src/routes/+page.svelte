<script lang="ts">let { data } = $props();</script>
<section class="hero"><p class="eyebrow">CONTROL PLANE / BOOTSTRAP</p><h1>Truth before intelligence.</h1><p>The foundation exposes engineering readiness and traceability without claiming that any crypto-intelligence capability is active.</p></section>
<section class="grid">
  {#each data.sections as section}
    <article><h2>{section.title}</h2><strong>{section.value}</strong><p>{section.detail}</p></article>
  {/each}
</section>
<p class="timestamp">Local snapshot generated {data.generatedAt}</p>
<style>
  .hero{max-width:760px;margin-bottom:3rem}.eyebrow{color:#5dd6c0;font-size:.75rem;letter-spacing:.16em}.hero h1{font-size:clamp(2.4rem,7vw,5.5rem);line-height:.95;margin:.6rem 0 1.2rem;color:#f1fbff}.hero>p:last-child{font-size:1.15rem;line-height:1.65;color:#9eb4be}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:1rem}article{padding:1.2rem;border:1px solid #263b46;border-radius:10px;background:linear-gradient(145deg,#0d1c25,#0a151d)}h2{font-size:.8rem;color:#88a2ae;text-transform:uppercase;letter-spacing:.07em;margin:0 0 1rem}article strong{font-size:1.25rem;color:#e8f7fa}article p{color:#849ba6;line-height:1.45}.timestamp{margin-top:2rem;color:#637a84;font-size:.75rem}
</style>
