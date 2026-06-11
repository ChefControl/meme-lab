<script lang="ts">
  import { store } from "../lib/store.svelte";
  import type { Template } from "../lib/types";

  const pct = (t: Template) => Math.min(100, Math.round((t.examples / t.min_examples) * 100));
</script>

<section class="view">
  <div class="view-head">
    <h2>Template library <span class="muted-note">({store.app.harvested} memes harvested)</span></h2>
    <div class="view-actions">
      <button class="secondary" disabled={store.locked} onclick={() => (store.seedOpen = true)}>🌱 Seed a template</button>
      <button disabled={store.locked} onclick={() => store.harvest()}>⛏ Harvest</button>
    </div>
  </div>

  {#if store.app.templates.length}
    <div class="tpl-grid">
      {#each store.app.templates as t (t.slug)}
        <div class="tpl-card">
          <img src={`/proxy?url=${encodeURIComponent(t.blank_url)}`} alt={t.name} loading="lazy" />
          <h3>
            {t.name}
            {#if t.analyzed}<span class="badge">analyzed{t.revision > 1 ? ` · r${t.revision}` : ""}</span>{/if}
            {#if t.revision > 1}<span class="badge revised">format-corrected</span>{/if}
            {#if t.learnings}<span class="badge learned">learning active</span>{/if}
          </h3>
          <div class="meta-line">
            {t.examples}/{t.min_examples} examples ·
            <span class="f">😂 {t.funny}</span> /
            <span class="m">😐 {t.meh}</span> /
            <span class="x">🧠 {t.bad_context ?? 0}</span> /
            <span class="s">📐 {t.bad_structure ?? 0}</span>
            {#if t.pending.length} · {t.pending.length} to rate{/if}
          </div>
          <div class="bar"><div style:width={`${pct(t)}%`}></div></div>
          <div class="btns">
            {#if t.examples < t.min_examples}
              <button class="secondary" disabled={store.locked} onclick={() => store.seed(t.name)}>
                🌱 Seed more ({t.min_examples - t.examples} needed)
              </button>
            {/if}
            {#if !t.analyzed && t.examples >= t.min_examples}
              <button class="secondary" disabled={store.locked}
                onclick={() => store.doJob(`/api/analyze/${t.slug}`, `Analyzing ${t.name}…`)}>🔬 Analyze</button>
            {/if}
            {#if t.analyzed}
              <button class="secondary" disabled={store.locked}
                onclick={() => store.doJob(`/api/generate/${t.slug}`, `Generating candidates for ${t.name}…`)}>⚡ Generate 10</button>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <div class="empty">
      Library is empty — <b>🌱 Seed</b> a template from the dropdown (12 instant examples from imgflip)
      or <b>⛏ Harvest</b> top Reddit memes. A template unlocks analysis at 10 examples.
    </div>
  {/if}
</section>
