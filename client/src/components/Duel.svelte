<script lang="ts">
  import { store } from "../lib/store.svelte";

  function onKey(e: KeyboardEvent) {
    if (!store.duelPair) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); void store.vote(0); }
    else if (e.key === "ArrowRight") { e.preventDefault(); void store.vote(1); }
    else if (e.key === " ") { e.preventDefault(); void store.loadDuel(true); }
  }
</script>

<svelte:window onkeydown={onKey} />

<section class="section">
  <div class="duel-head">
    <h2 class="page-title">⚔ Funny face-off</h2>
    <div class="page-sub">click the funnier one · winner gains Elo · {store.board.length} ranked</div>
  </div>

  {#if store.duelPair}
    <div class="duel-stage">
      {#each store.duelPair as f, i (f.slug + f.id)}
        <button class="duel-card" onclick={() => store.vote(i as 0 | 1)}>
          <img src={f.image} alt={`contender ${i === 0 ? "A" : "B"}`} />
          <div class="duel-meta">
            <span>{f.template}</span>
            <span class="elo">elo {f.elo}</span>
            <span class="d">{f.duels}d</span>
          </div>
        </button>
      {/each}
    </div>
    <div class="duel-skip-wrap">
      <button class="btn" onclick={() => store.loadDuel(true)}>skip matchup <span class="key">space</span></button>
    </div>
  {:else}
    <div class="empty">
      The arena needs at least two <b>😂 funny</b>-rated memes. Rate some candidates first.
    </div>
  {/if}
</section>
