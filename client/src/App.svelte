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

  onMount(() => store.init());
</script>

<div class="app">
  <Sidebar />
  <div class="content">
    <div class="status">
      {#if store.status}<span class="status-dot">›</span>{store.status}{/if}
    </div>
    {#if store.view === "library"}<Library />{/if}
    {#if store.view === "rate"}<Rate />{/if}
    {#if store.view === "duel"}<Duel />{/if}
    {#if store.view === "board"}<Leaderboard />{/if}
  </div>
</div>

{#if store.seedOpen}<SeedModal />{/if}
{#if store.lightboxIndex !== null}<Lightbox />{/if}
