<script lang="ts">
  import { store } from "../lib/store.svelte";
  import type { Template } from "../lib/types";

  const pct = (t: Template) => Math.min(100, Math.round((t.examples / t.min_examples) * 100));

  // Live per-stage dashboard — the strip doubles as a pipeline status readout,
  // every count derived from real template state.
  const strip = $derived.by(() => {
    const t = store.app.templates;
    const readyToAnalyze = t.filter((x) => !x.analyzed && x.examples >= x.min_examples).length;
    const gathering = t.filter((x) => x.examples < x.min_examples).length;
    const analyzedCount = t.filter((x) => x.analyzed).length;
    const learningCount = t.filter((x) => !!x.learnings).length;
    const pendingTotal = t.reduce((a, x) => a + x.pending.length, 0);
    const queueLeft = store.queue.length;
    const queued = queueLeft || pendingTotal;
    return [
      { label: "harvest", icon: "⛏", count: `${store.app.harvested.toLocaleString()} harvested`, tone: "", view: "library" as const },
      { label: "analyze", icon: "🔬",
        count: readyToAnalyze ? `${readyToAnalyze} ready to analyze` : `${gathering} gathering examples`,
        tone: readyToAnalyze ? "amber" : "", view: "library" as const },
      { label: "generate", icon: "⚡", count: `${analyzedCount} templates ready`, tone: "", view: "library" as const },
      { label: "rate", icon: "📝", count: `${queued} candidates queued`, tone: queued ? "green" : "", active: true, view: "rate" as const },
      { label: "learn", icon: "🧠", count: `${learningCount} learning active`, tone: learningCount ? "green" : "", view: "library" as const },
      { label: "duel", icon: "⚔️", count: `${store.board.length} ranked`, tone: "", view: "duel" as const },
    ];
  });
</script>

<section class="section">
  <div class="page-head">
    <div>
      <h2 class="page-title">Template library</h2>
      <div class="page-sub">
        {store.app.harvested.toLocaleString()} memes harvested · {store.app.templates.length} templates in study
      </div>
    </div>
    <div class="head-actions">
      <button class="btn" disabled={store.locked} onclick={() => (store.seedOpen = true)}>🌱 Seed template</button>
      <button class="btn btn-primary" disabled={store.locked} onclick={() => store.harvest()}>⛏ Harvest</button>
    </div>
  </div>

  <!-- pipeline strip — live status dashboard -->
  <div class="pipe-strip">
    {#each strip as s, i (s.label)}
      <div class="pipe-item">
        <button class="pipe-btn" onclick={() => (store.view = s.view)}>
          <div class="pipe-row">
            <span class="pipe-chip" class:active={s.active}>{s.icon}</span>
            <span class="pipe-label">{s.label}</span>
          </div>
          <span class="pipe-count {s.tone}">{s.count}</span>
        </button>
        <span class="pipe-arrow">{i < strip.length - 1 ? "→" : "↻"}</span>
      </div>
    {/each}
  </div>

  {#if store.app.templates.length}
    <div class="tpl-grid">
      {#each store.app.templates as t (t.slug)}
        <div class="tpl-card">
          <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
          <div class="tpl-thumb" onclick={() => store.openDetail(t.slug)}>
            <img src={`/proxy?url=${encodeURIComponent(t.blank_url)}`} alt={t.name} loading="lazy" />
            <span class="tpl-boxbadge">{t.box_count} boxes</span>
          </div>

          <div class="tpl-titlerow">
            <h3 class="tpl-name">{t.name}</h3>
            {#if t.analyzed}<span class="tpl-badge analyzed">{t.revision > 1 ? `analyzed·r${t.revision}` : "analyzed"}</span>{/if}
            {#if t.revision > 1}<span class="tpl-badge revised">format-corrected</span>{/if}
            {#if t.learnings}<span class="tpl-badge learning">learning active</span>{/if}
          </div>

          <div class="tpl-stats">
            <span class="f">😂 {t.funny}</span>
            <span class="m">😐 {t.meh}</span>
            <span class="x">🧠 {t.bad_context ?? 0}</span>
            <span class="s">📐 {t.bad_structure ?? 0}</span>
            <span class="ex">{t.examples}/{t.min_examples} ex</span>
          </div>

          <div class="tpl-bar">
            <div style:width={`${pct(t)}%`}
              style:background={pct(t) >= 100 ? "linear-gradient(90deg,#74e98c,#4fd0c0)" : "#e8855c"}></div>
          </div>

          <div class="tpl-actions">
            {#if t.examples < t.min_examples}
              <button class="btn" disabled={store.locked} onclick={() => store.seed(t.name)}>
                🌱 Seed ({t.min_examples - t.examples} more)
              </button>
            {:else if !t.analyzed}
              <button class="btn btn-purple" disabled={store.locked}
                onclick={() => store.doJob(`/api/analyze/${t.slug}`, `🔬 deriving usage for ${t.name}…`)}>🔬 Analyze</button>
            {:else}
              <button class="btn btn-primary" disabled={store.locked}
                onclick={() => store.doJob(`/api/generate/${t.slug}`, `⚡ generating candidates for ${t.name}…`)}>⚡ Generate 10</button>
            {/if}
            <button class="btn btn-details" onclick={() => store.openDetail(t.slug)}>Details</button>
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <div class="empty">
      Library is empty — <b>🌱 Seed template</b> for 12 instant examples from imgflip,
      or <b>⛏ Harvest</b> top Reddit memes. A template unlocks analysis at 10 examples.
    </div>
  {/if}
</section>
