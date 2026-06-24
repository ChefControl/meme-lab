<script lang="ts">
  import { store } from "../lib/store.svelte";

  const rankIcon = (i: number) => (i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "#" + (i + 1));

  const i = $derived(store.lightboxIndex ?? 0);
  const f = $derived(store.board[i]);

  function step(d: number) {
    const n = store.board.length;
    if (n) store.lightboxIndex = (((i + d) % n) + n) % n;
  }
  function close() { store.lightboxIndex = null; }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
  }
</script>

<svelte:window onkeydown={onKey} />

{#if f}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="modal" onclick={(e) => e.currentTarget === e.target && close()}>
    <div class="lightbox-box">
      <button class="icon-btn lb-close" onclick={close} aria-label="Close">✕</button>
      <img src={f.image} alt="meme" />
      <div class="lb-meta">
        {rankIcon(i)} “{f.top}”{f.bottom ? ` / “${f.bottom}”` : ""}
        <small>{f.template} · <span class="elo">elo {f.elo}</span> · {f.duels} duels</small>
      </div>
      <div class="lb-nav">
        <button class="btn" onclick={() => step(-1)}>←</button>
        <span class="lb-pos">{i + 1} / {store.board.length}</span>
        <button class="btn" onclick={() => step(1)}>→</button>
      </div>
    </div>
  </div>
{/if}
