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
      <h3 class="modal-title">Seed a template</h3>
      <input class="modal-search" bind:this={searchEl} bind:value={filter} type="text"
        placeholder="Search templates… (e.g. cat, drake, button)" autocomplete="off" />
      <button class="icon-btn" onclick={close} aria-label="Close">✕</button>
    </div>
    <div class="modal-hint">
      pulls 12 guaranteed instances straight from imgflip — no waiting on the harvest feed. Pick any number;
      Meme Lab runs <b>seed → analyze → generate</b> for each, then drops you into rating. Greyed tiles are already in your library.
    </div>

    <div class="seed-grid">
      {#if !store.imgflip.length}
        <div class="seed-loading">Loading templates…</div>
      {:else if !matches.length}
        <div class="seed-loading">No templates match “{filter}”.</div>
      {:else}
        {#each matches as t (t.name)}
          {@const already = inLib.has(t.name.toLowerCase())}
          <button class="seed-tile" class:in-lib={already} class:selected={selected.has(t.name)}
            disabled={already} onclick={() => !already && toggle(t.name)}>
            <div class="seed-thumb"><img src={`/proxy?url=${encodeURIComponent(t.url)}`} alt={t.name} loading="lazy" /></div>
            <div class="seed-tile-body">
              <div class="seed-tile-name">{t.name}</div>
              <div class="seed-tile-sub">{already ? "already in library" : `${t.box_count} boxes`}</div>
            </div>
          </button>
        {/each}
      {/if}
    </div>

    <div class="modal-foot">
      <span class="sel-count">{selected.size} selected</span>
      <button class="btn" onclick={() => (selected = new Set())}>Clear</button>
      <span class="spacer"></span>
      <button class="btn btn-primary" disabled={selected.size === 0} onclick={confirm}>🚀 Seed → analyze → generate</button>
    </div>
  </div>
</div>
