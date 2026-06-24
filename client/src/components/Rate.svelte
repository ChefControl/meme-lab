<script lang="ts">
  import { store } from "../lib/store.svelte";
  import { renderCandidate } from "../lib/meme";
  import type { Rating } from "../lib/types";

  let canvas = $state<HTMLCanvasElement>();
  let swipeCard = $state<HTMLDivElement>();
  let problemMode = $state(false);
  let cardLocked = false;                        // true mid-fling, blocks double-rates
  let drag: { x: number; y: number } | null = null;

  const SWIPE_THRESHOLD = 90;
  const current = $derived(store.current);
  const deckItems = $derived(store.queue.slice(1, 3)); // next up-to-2, shown as a deck behind
  let deckCanvases = $state<HTMLCanvasElement[]>([]);
  const progressPct = $derived.by(() => {
    const done = store.ratedThisSession;
    const total = done + store.queue.length;
    return total ? Math.round((done / total) * 100) : 0;
  });

  // pos → rating, by mode. funny ← left, meh → right, problem ↓ down.
  function actAt(pos: string): string | null {
    const map = problemMode
      ? { left: "bad_context", right: "bad_structure", down: "cancel", up: null }
      : { left: "funny", right: "meh", down: "problem", up: null };
    return (map as Record<string, string | null>)[pos] ?? null;
  }

  // redraw whenever the active candidate changes
  $effect(() => {
    if (current && canvas) {
      resetCard();
      renderCandidate(canvas, current, 700, () => (store.status = "Failed to load template image"));
    }
  });

  // render the next candidates into the cards stacked behind, like a deck
  $effect(() => {
    deckItems.forEach((item, i) => {
      const c = deckCanvases[i];
      if (c) renderCandidate(c, item, 460);
    });
  });

  function resetCard() {
    if (!swipeCard) return;
    swipeCard.classList.remove("dragging");
    swipeCard.style.transform = "";
    swipeCard.querySelectorAll<HTMLElement>(".swipe-tag").forEach((t) => (t.style.opacity = "0"));
  }

  function posFromDelta(dx: number, dy: number): string | null {
    if (Math.abs(dx) > Math.abs(dy)) return Math.abs(dx) < SWIPE_THRESHOLD ? null : dx > 0 ? "right" : "left";
    return Math.abs(dy) < SWIPE_THRESHOLD ? null : dy < 0 ? "up" : "down";
  }
  function domPos(dx: number, dy: number): string {
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy < 0 ? "up" : "down";
  }

  // Map an action to the swipe-tag that should light up while dragging.
  const TAG_FOR: Record<string, string> = {
    funny: "funny", meh: "meh", problem: "problem", bad_context: "funny", bad_structure: "meh",
  };
  function paintDrag(dx: number, dy: number) {
    if (!swipeCard) return;
    swipeCard.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 22}deg)`;
    const act = actAt(domPos(dx, dy));
    const tag = act ? TAG_FOR[act] : null;
    const mag = Math.min(1, Math.max(Math.abs(dx), Math.abs(dy)) / SWIPE_THRESHOLD);
    swipeCard.querySelectorAll<HTMLElement>(".swipe-tag").forEach(
      (t) => (t.style.opacity = t.dataset.dir === tag ? String(mag) : "0"));
  }

  function flingCard(act: string, done: () => void) {
    if (!swipeCard) return done();
    const W = window.innerWidth, H = window.innerHeight;
    const offsets: Record<string, [number, number, number]> = {
      funny: [-W, 60, -18], meh: [W, 60, 18], bad_context: [-W, -40, -12], bad_structure: [W, 40, 12],
    };
    const [x, y, rot] = offsets[act] || [0, H, 0];
    swipeCard.classList.remove("dragging");
    swipeCard.style.transform = `translate(${x}px, ${y}px) rotate(${rot}deg)`;
    setTimeout(() => { done(); resetCard(); cardLocked = false; }, 200);
  }

  function enterProblem() { problemMode = true; resetCard(); }
  function exitProblem() { if (problemMode) { problemMode = false; resetCard(); } }

  function commit(rating: Rating) {
    const image = canvas!.toDataURL("image/png");
    problemMode = false;
    void store.commitRating(rating, "", image);
  }

  // One-tap: funny/meh and both flags fling-and-commit immediately (no reason sheet).
  function trigger(act: string | null) {
    if (!act || !current || cardLocked) return;
    if (act === "problem") return enterProblem();
    if (act === "cancel") return exitProblem();
    cardLocked = true;
    flingCard(act, () => commit(act as Rating));
  }

  // pointer drag
  function onPointerDown(e: PointerEvent) {
    if (!current || cardLocked || (e.target as HTMLElement).closest("a, button")) return;
    drag = { x: e.clientX, y: e.clientY };
    swipeCard!.classList.add("dragging");
    swipeCard!.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: PointerEvent) { if (drag) paintDrag(e.clientX - drag.x, e.clientY - drag.y); }
  function onPointerUp(e: PointerEvent) {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag = null;
    const pos = posFromDelta(dx, dy);
    if (pos) trigger(actAt(pos)); else resetCard();
  }

  // keyboard
  function onKey(e: KeyboardEvent) {
    const typing = /^(INPUT|TEXTAREA)$/.test((document.activeElement as HTMLElement)?.tagName ?? "");
    if (typing) return;
    if (e.key === "Escape") { exitProblem(); return; }
    if (!current) return;
    const POS: Record<string, string> = {
      ArrowLeft: "left", a: "left", ArrowRight: "right", d: "right",
      ArrowDown: "down", s: "down", ArrowUp: "up",
    };
    if (POS[e.key]) { e.preventDefault(); trigger(actAt(POS[e.key])); return; }
    if (!problemMode && e.key === "f") { e.preventDefault(); trigger("funny"); }
    if (!problemMode && e.key === "m") { e.preventDefault(); trigger("meh"); }
  }
</script>

<svelte:window onkeydown={onKey} />

<section class="rate-section">
  <div class="rate-col">
    {#if current}
      <div class="rate-progress">
        <div class="rate-progress-head">
          <span class="title">Rate this candidate</span>
          <span class="meta">✓ {store.ratedThisSession} rated · {store.queue.length} left</span>
        </div>
        <div class="rate-bar"><div style:width={`${progressPct}%`}></div></div>
      </div>

      <div class="card-deck">
        {#each deckItems as item, i (item.candidate.id)}
          <div class="deck-layer" data-layer={i + 1}>
            <canvas bind:this={deckCanvases[i]}></canvas>
          </div>
        {/each}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div bind:this={swipeCard} class="swipe-card"
          onpointerdown={onPointerDown} onpointermove={onPointerMove}
          onpointerup={onPointerUp} onpointercancel={() => { drag = null; resetCard(); }}>
          <canvas bind:this={canvas} class="meme-canvas"></canvas>
          <div class="swipe-tag" data-dir="funny">FUNNY</div>
          <div class="swipe-tag" data-dir="meh">MEH</div>
          <div class="swipe-tag" data-dir="problem">PROBLEM</div>
          <div class="swipe-card-foot">
            <span class="name">{current.name}</span>
            <span class="meta">
              {current.candidate.batch ? `round ${current.candidate.batch} · ` : ""}gen #{current.candidate.id}
            </span>
          </div>
        </div>
      </div>

      {#if problemMode}
        <div class="problem-row">
          <div class="problem-title">⚠ What's wrong with it?</div>
          <div class="problem-acts">
            <button class="rate-act ctx" onclick={() => trigger("bad_context")}>
              <div class="emoji">🧠</div><div class="lbl">Wrong idea</div><div class="sub">missed the core</div>
            </button>
            <button class="rate-act struct" onclick={() => trigger("bad_structure")}>
              <div class="emoji">📐</div><div class="lbl">Bad structure</div><div class="sub">wrong length/labels</div>
            </button>
            <button class="rate-act back" onclick={exitProblem}>
              <div class="emoji">✕</div><div class="sub">back</div>
            </button>
          </div>
        </div>
      {:else}
        <div class="rate-actions">
          <button class="rate-act funny" onclick={() => trigger("funny")}>
            <div class="emoji">😂</div><div class="lbl">Funny</div>
          </button>
          <button class="rate-act problem" onclick={enterProblem}>
            <div class="emoji">⚠️</div><div class="lbl">Problem</div>
          </button>
          <button class="rate-act meh" onclick={() => trigger("meh")}>
            <div class="emoji">😐</div><div class="lbl">Not funny</div>
          </button>
        </div>
      {/if}

      <div class="kbd-hints">
        <span><b>←</b> funny</span>
        <span><b>→</b> meh</span>
        <span><b>↓</b> problem</span>
        <span><b>drag</b> to fling</span>
      </div>
    {:else}
      <div class="rate-empty">
        <div class="big">🎉</div>
        <div class="h">Queue cleared</div>
        <div class="p">Your taste just steered the next round. Generate more candidates, or send the funny ones to the arena.</div>
        <div class="row">
          <button class="btn btn-primary" onclick={() => (store.view = "library")}>⚡ Generate more</button>
          <button class="btn" onclick={() => (store.view = "duel")}>⚔ To the arena</button>
        </div>
      </div>
    {/if}
  </div>
</section>
