<script lang="ts">
  import { onMount } from "svelte";
  import { store } from "./lib/store.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import Library from "./components/Library.svelte";
  import Rate from "./components/Rate.svelte";
  import Duel from "./components/Duel.svelte";
  import Leaderboard from "./components/Leaderboard.svelte";
  import SeedModal from "./components/SeedModal.svelte";
  import Lightbox from "./components/Lightbox.svelte";
  import TemplateDrawer from "./components/TemplateDrawer.svelte";

  onMount(() => store.init());

  // The status bar dot is amber while a job holds the server, green when idle.
  const dot = $derived(store.locked ? "#f0b85e" : "#74e98c");
  const statusText = $derived(store.status || "idle · ready for the next job");
</script>

<div class="app">
  <div class="lab-texture"></div>

  <Sidebar />

  <main class="main">
    <div class="statusbar">
      <span class="sdot" style:background={dot} style:box-shadow={`0 0 8px ${dot}`}></span>
      <span class="stext">{statusText}</span>
      <span class="smeta">localhost:5050 · single-user</span>
    </div>

    <div class="content">
      {#if store.view === "library"}<Library />{/if}
      {#if store.view === "rate"}<Rate />{/if}
      {#if store.view === "duel"}<Duel />{/if}
      {#if store.view === "board"}<Leaderboard />{/if}
    </div>
  </main>

  {#if store.detailSlug}<TemplateDrawer />{/if}
  {#if store.seedOpen}<SeedModal />{/if}
  {#if store.lightboxIndex !== null}<Lightbox />{/if}
  {#if store.toast}<div class="toast">{store.toast}</div>{/if}
</div>
