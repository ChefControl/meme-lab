<script lang="ts">
  import { store } from "../lib/store.svelte";
  import { live } from "../lib/live.svelte";
  import type { View } from "../lib/types";

  const nav = $derived<{ view: View; icon: string; label: string; count: string | number; hot?: boolean }[]>([
    { view: "library", icon: "📚", label: "Library", count: store.app.templates.length },
    { view: "rate", icon: "📝", label: "Rate", count: store.queue.length, hot: store.queue.length > 0 },
    { view: "duel", icon: "⚔️", label: "Face-off", count: store.duelPair ? "⚡" : 0 },
    { view: "board", icon: "🏆", label: "Leaderboard", count: store.board.length },
    { view: "live", icon: "📷", label: "Live", count: live.sounds.length || "⚡", hot: live.sounds.length > 0 },
  ]);

  // "The loop" mirrors the real pipeline state — each dot lights as that stage
  // has produced something; `rate` glows while a queue is waiting on you.
  const loop = $derived.by(() => {
    const t = store.app.templates;
    return [
      { label: "harvest", done: store.app.harvested > 0 },
      { label: "analyze", done: t.some((x) => x.analyzed) },
      { label: "generate", done: t.some((x) => x.pending.length > 0 || x.funny > 0 || x.meh > 0) },
      { label: "rate", done: false, active: store.queue.length > 0 },
      { label: "learn", done: t.some((x) => !!x.learnings) },
      { label: "duel", done: store.board.length > 0 },
    ];
  });
</script>

<aside class="sidebar">
  <div class="brand">
    <div class="brand-mark">⚗</div>
    <div class="brand-name">meme<span>lab</span></div>
  </div>

  <nav class="nav">
    {#each nav as n (n.view)}
      <button class:active={store.view === n.view} onclick={() => (store.view = n.view)}>
        <span class="nav-ico">{n.icon}</span>
        <span>{n.label}</span>
        {#if n.count !== 0 && n.count !== ""}
          <span class="nav-badge" class:hot={n.hot}>{n.count}</span>
        {/if}
      </button>
    {/each}
  </nav>

  <div class="loop">
    <div class="loop-title">the loop</div>
    <div class="loop-list">
      {#each loop as s (s.label)}
        <div class="loop-step" class:done={s.done} class:active={s.active}>
          <span class="loop-dot"></span>
          <span>{s.label}</span>
        </div>
      {/each}
    </div>
  </div>
</aside>
