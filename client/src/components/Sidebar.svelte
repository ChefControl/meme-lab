<script lang="ts">
  import { store } from "../lib/store.svelte";
  import type { View } from "../lib/types";

  const items: { view: View; label: string }[] = [
    { view: "library", label: "📚 Library" },
    { view: "rate", label: "📝 Rate" },
    { view: "duel", label: "⚔️ Face-off" },
    { view: "board", label: "🏆 Leaderboard" },
  ];
</script>

<aside class="sidebar">
  <h1>🧪 Meme <span>Lab</span></h1>
  <nav>
    {#each items as it (it.view)}
      <button class:active={store.view === it.view} onclick={() => (store.view = it.view)}>
        {it.label}
        {#if it.view === "library" && store.app.templates.length}
          <span class="count">{store.app.templates.length}</span>
        {:else if it.view === "rate" && store.queue.length}
          <span class="count hot">{store.queue.length}</span>
        {:else if it.view === "duel" && store.duelPair}
          <span class="count">⚡</span>
        {:else if it.view === "board" && store.board.length}
          <span class="count">{store.board.length}</span>
        {/if}
      </button>
    {/each}
  </nav>
  <div class="side-foot">
    harvest → analyze → generate →<br />you rate → it learns →<br />memes duel for the crown
  </div>
</aside>
