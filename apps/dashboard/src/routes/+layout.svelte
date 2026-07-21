<script lang="ts">let { children } = $props();</script>
<svelte:head><title>CIAG Bootstrap Console</title><meta name="description" content="Read-only engineering and harness status" /></svelte:head>
<header><div><strong>Crypto Intelligence Agent Gateway</strong><small>Engineering console · synthetic shadow only</small></div><span>NO LIVE CAPABILITIES</span></header>
<main>{@render children()}</main>
<footer>Read-only bootstrap surface. No investment recommendations or execution capabilities.</footer>
<style>
  :global(*){box-sizing:border-box} :global(body){margin:0;font-family:Inter,ui-sans-serif,system-ui;background:#071018;color:#d9e7ee} header{display:flex;justify-content:space-between;align-items:center;padding:1.2rem 4vw;border-bottom:1px solid #243642;background:#0b1720} header div{display:grid;gap:.25rem} small{color:#8ba3af} header span{font-size:.72rem;letter-spacing:.08em;color:#ffbf69;border:1px solid #805b22;padding:.4rem .6rem;border-radius:99px} main{max-width:1200px;margin:auto;padding:3rem 4vw;min-height:80vh} footer{padding:1rem 4vw;border-top:1px solid #243642;color:#8ba3af;font-size:.8rem}
</style>
