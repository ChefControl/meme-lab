<script lang="ts">
  import { store } from "../lib/store.svelte";

  const d = $derived(store.detail);

  function close() { store.closeDetail(); }
  function generate() {
    const slug = store.detailSlug;
    close();
    if (slug) void store.doJob(`/api/generate/${slug}`, `⚡ generating candidates for ${d?.name ?? slug}…`);
  }
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && close()} />

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="drawer-scrim" onclick={close}></div>
<aside class="drawer">
  <div class="drawer-head">
    <div>
      <div class="drawer-eyebrow">analysis{d && d.analyzed ? ` · rev ${d.revision}` : ""}</div>
      <h3 class="drawer-title">{d?.name ?? "…"}</h3>
    </div>
    <button class="icon-btn" onclick={close} aria-label="Close">✕</button>
  </div>

  <div class="drawer-body">
    {#if !d}
      <div class="drawer-loading">Loading analysis…</div>
    {:else if !d.analyzed}
      <div class="drawer-text sm">
        This template hasn't been analyzed yet. Once it has 10+ examples, run <b>🔬 Analyze</b> to derive
        its core idea, caption-box meanings, and writing rules.
      </div>
    {:else}
      <div>
        <div class="drawer-label">core idea</div>
        <div class="drawer-text">{d.core_idea || "—"}</div>
      </div>
      <div>
        <div class="drawer-label">thrives in</div>
        <div class="drawer-text sm">{d.context || "—"}</div>
      </div>
      {#if d.boxes.length}
        <div>
          <div class="drawer-label">caption boxes</div>
          <div class="drawer-boxes">
            {#each d.boxes as bx (bx.role)}
              <div class="drawer-box">
                <span class="role">{bx.role}</span>
              </div>
            {/each}
          </div>
        </div>
      {/if}
      {#if d.rules.length}
        <div>
          <div class="drawer-label">writing rules</div>
          <div class="drawer-rules">
            {#each d.rules as r (r)}
              <div class="drawer-rule"><span class="arrow">→</span><span>{r}</span></div>
            {/each}
          </div>
        </div>
      {/if}
      <div class="prompt-grid">
        <div class="prompt pos">
          <div class="prompt-label">＋ positive prompt</div>
          <div class="prompt-text">{d.learning ? d.positive_prompt : "— not learned yet (rate some candidates) —"}</div>
        </div>
        <div class="prompt neg">
          <div class="prompt-label">－ negative prompt</div>
          <div class="prompt-text">{d.learning ? d.negative_prompt : "— not learned yet —"}</div>
        </div>
      </div>
    {/if}
  </div>

  <div class="drawer-foot">
    {#if d && d.analyzed}
      <button class="btn btn-primary" disabled={store.locked} onclick={generate}>⚡ Generate 10 candidates</button>
    {/if}
    <button class="btn btn-close" onclick={close}>Close</button>
  </div>
</aside>
