<script lang="ts">
  import { store } from "../lib/store.svelte";

  const rankIcon = (i: number) => (i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "#" + (i + 1));
  const caption = (top: string, bottom: string) =>
    top ? top + (bottom ? " / " + bottom : "") : bottom;
</script>

<section class="section">
  <div style="margin-bottom:22px;">
    <h2 class="page-title">🏆 Funniest memes</h2>
    <div class="page-sub">ranked by Elo across all templates · {store.board.length} ranked</div>
  </div>

  {#if store.board.length}
    <div class="board">
      {#each store.board as f, i (f.slug + f.id)}
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div class="board-row" class:top={i < 3} onclick={() => (store.lightboxIndex = i)}>
          <div class="board-rank">{rankIcon(i)}</div>
          <div class="board-thumb"><img src={f.image} alt="" loading="lazy" /></div>
          <div class="board-cap">
            <div class="text">“{caption(f.top, f.bottom)}”</div>
            <div class="name">{f.template}</div>
          </div>
          <div class="board-elo">
            <div class="v">{f.elo}</div>
            <div class="d">{f.duels} duels</div>
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <div class="empty">
      No ranked memes yet — rate candidates as <b>😂 funny</b> and fight some <b>⚔ face-offs</b>.
    </div>
  {/if}
</section>
