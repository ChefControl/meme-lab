<script lang="ts">
  import { onMount } from "svelte";
  import { store } from "../lib/store.svelte";

  let filter = $state("");
  let selected = $state<Set<string>>(new Set());
  let searchEl = $state<HTMLInputElement>();

  const inLib = $derived(new Set(store.app.templates.map((t) => t.name.toLowerCase())));
  const matches = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    return store.imgflip.filter((t) => !q || t.name.toLowerCase().includes(q));
  });

  function toggle(name: string) {
    const s = new Set(selected);
    s.has(name) ? s.delete(name) : s.add(name);
    selected = s;
  }
  function close() { store.seedOpen = false; }
  async function confirm() {
    const names = [...selected];
    close();
    await store.autoPipeline(names);
  }

  onMount(() => { void store.loadImgflip(); searchEl?.focus(); });
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && close()} />

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="modal" onclick={(e) => e.currentTarget === e.target && close()}>
  <div class="modal-box">
    <div class="modal-head">
      <h2>🌱 Pick a template to seed</h2>
      <input bind:this={searchEl} bind:value={filter} type="text"
        placeholder="Search templates… (e.g. cat, drake, button)" autocomplete="off" />
      <button class="secondary" onclick={close}>✕</button>
    </div>
    <p class="modal-hint">
      Pick templates, then hit go — Meme Lab runs the whole lifecycle for each automatically:
      <b>seed</b> (12 real community memes) → <b>analyze</b> → <b>generate</b> a few candidates, then drops you
      straight into rating. Greyed-out tiles are already in your library.
    </p>
    <div class="seed-gallery">
      {#if !store.imgflip.length}
        <div class="gallery-loading">Loading templates…</div>
      {:else if !matches.length}
        <div class="empty" style="grid-column: 1/-1">No templates match “{filter}”.</div>
      {:else}
        {#each matches as t (t.name)}
          {@const already = inLib.has(t.name.toLowerCase())}
          <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
          <div class="seed-tile" class:in-lib={already} class:selected={selected.has(t.name)}
            onclick={() => !already && toggle(t.name)}>
            <img src={`/proxy?url=${encodeURIComponent(t.url)}`} alt={t.name} loading="lazy" />
            <div class="tile-name">{t.name}<small>{already ? "already in library" : `${t.box_count} text boxes`}</small></div>
          </div>
        {/each}
      {/if}
    </div>
    <div class="modal-foot">
      <span class="sel-count">{selected.size} selected</span>
      <button class="secondary" onclick={() => (selected = new Set())}>Clear</button>
      <span class="spacer"></span>
      <button disabled={selected.size === 0} onclick={confirm}>🚀 Seed → analyze → generate</button>
    </div>
  </div>
</div>
