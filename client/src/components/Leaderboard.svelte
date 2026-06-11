<script lang="ts">
  import { store } from "../lib/store.svelte";

  const rankIcon = (i: number) => (i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "#" + (i + 1));
</script>

<section class="view">
  <div class="view-head"><h2>🏆 Funniest memes</h2></div>
  {#if store.board.length}
    <div class="board">
      {#each store.board as f, i (f.slug + f.id)}
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div class="board-row" onclick={() => (store.lightboxIndex = i)}>
          <div class="rank">{rankIcon(i)}</div>
          <img src={f.image} alt="" loading="lazy" />
          <div class="cap">“{f.top}”{f.bottom ? ` / “${f.bottom}”` : ""}<small>{f.template}</small></div>
          <div class="elo">{f.elo}<small>{f.duels} duels</small></div>
        </div>
      {/each}
    </div>
  {:else}
    <div class="empty">
      No ranked memes yet — rate candidates as <b>😂 funny</b> and fight some <b>⚔️ face-offs</b>.
    </div>
  {/if}
</section>
