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

<section class="view">
  <div class="view-head"><h2>⚔️ Funny face-off <span class="muted-note">— click the funnier one</span></h2></div>
  {#if store.duelPair}
    <div class="panel">
      <div class="duel-stage">
        {#each store.duelPair as f, i (f.slug + f.id)}
          {#if i === 1}<div class="vs">VS</div>{/if}
          <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
          <div class="duel-card" onclick={() => store.vote(i as 0 | 1)}>
            <img src={f.image} alt={`contender ${i === 0 ? "A" : "B"}`} />
            <div class="duel-meta">{f.template} · elo {f.elo} · {f.duels} duels</div>
          </div>
        {/each}
      </div>
      <div class="duel-actions"><button class="secondary" onclick={() => store.loadDuel(true)}>skip matchup</button></div>
    </div>
  {:else}
    <div class="empty">
      The arena needs at least two <b>😂 funny</b>-rated memes. Rate some candidates first.
    </div>
  {/if}
</section>
