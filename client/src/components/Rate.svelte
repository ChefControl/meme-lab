<script lang="ts">
  import { store } from "../lib/store.svelte";
  import { renderCandidate } from "../lib/meme";
  import type { Rating } from "../lib/types";
  import ReasonSheet from "./ReasonSheet.svelte";

  let canvas = $state<HTMLCanvasElement>();
  let swipeCard = $state<HTMLDivElement>();
  let problemMode = $state(false);
  let reasonFlag = $state<Rating | null>(null); // bad_context/bad_structure sheet
  let cardLocked = false;                        // true mid-fling, blocks double-rates
  let drag: { x: number; y: number } | null = null;

  const SWIPE_THRESHOLD = 90;
  const current = $derived(store.current);
  const behind = $derived(Math.min(3, Math.max(0, store.queue.length - 1)));
  const progressPct = $derived.by(() => {
    const done = store.ratedThisSession;
    const total = done + store.queue.length;
    return total ? Math.round((done / total) * 100) : 0;
  });

  // The 3 on-image buttons swap meaning between normal and "what's wrong?" mode.
  const FACES = {
    normal: {
      left: { cls: "funny", icon: "😂", label: "Funny (←)" },
      right: { cls: "meh", icon: "😐", label: "Not funny (→)" },
      down: { cls: "prob", icon: "⚠️", label: "Problem (↓)" },
    },
    problem: {
      left: { cls: "ctx", icon: "🧠", label: "Wrong idea (←)" },
      right: { cls: "struct", icon: "📐", label: "Structural fail (→)" },
      down: { cls: "cancel", icon: "✕", label: "Back (↓ / Esc)" },
    },
  } as const;
  const faces = $derived(problemMode ? FACES.problem : FACES.normal);

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

  function paintDrag(dx: number, dy: number) {
    if (!swipeCard) return;
    swipeCard.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 22}deg)`;
    const act = actAt(domPos(dx, dy));
    const mag = Math.min(1, Math.max(Math.abs(dx), Math.abs(dy)) / SWIPE_THRESHOLD);
    swipeCard.querySelectorAll<HTMLElement>(".swipe-tag").forEach(
      (t) => (t.style.opacity = t.dataset.dir === act ? String(mag) : "0"));
  }

  function flingCard(act: string, done: () => void) {
    if (!swipeCard) return done();
    const W = window.innerWidth, H = window.innerHeight;
    const offsets: Record<string, [number, number, number]> = {
      funny: [W, 60, 18], meh: [-W, 60, -18], bad_context: [-W, -40, -12], bad_structure: [W, 40, 12],
    };
    const [x, y, rot] = offsets[act] || [0, H, 0];
    swipeCard.classList.remove("dragging");
    swipeCard.style.transform = `translate(${x}px, ${y}px) rotate(${rot}deg)`;
    setTimeout(() => { done(); resetCard(); cardLocked = false; }, 200);
  }

  function enterProblem() { problemMode = true; resetCard(); }
  function exitProblem() { if (problemMode) { problemMode = false; resetCard(); } }

  function commit(rating: Rating, reason = "") {
    const image = canvas!.toDataURL("image/png");
    problemMode = false;
    void store.commitRating(rating, reason, image);
  }

  function trigger(act: string | null) {
    if (!act || !current || cardLocked) return;
    if (act === "problem") return enterProblem();
    if (act === "cancel") return exitProblem();
    if (act === "funny" || act === "meh") {
      cardLocked = true;
      flingCard(act, () => commit(act as Rating));
      return;
    }
    resetCard();
    reasonFlag = act as Rating; // open the premade-reason sheet
  }

  // reason sheet callbacks
  function reasonConfirm(reason: string) { const t = reasonFlag!; reasonFlag = null; flingCard(t, () => commit(t, reason)); }
  function reasonSkip() { const t = reasonFlag!; reasonFlag = null; flingCard(t, () => commit(t, "")); }

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
    if (reasonFlag) { if (e.key === "Escape") { reasonFlag = null; exitProblem(); } return; }
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

<section class="view">
  <div class="view-head"><h2>Rate this one</h2></div>
  {#if current}
    <div class="panel">
      <div class="rate-progress">
        <div class="rate-bar"><div style:width={`${progressPct}%`}></div></div>
        <div class="rate-progress-text">
          {store.ratedThisSession ? `✓ ${store.ratedThisSession} rated this session` : ""}
        </div>
      </div>
      <div class="swipe-wrap">
        <div class="card-deck">
          {#if behind >= 3}<div class="deck-layer" data-layer="3"></div>{/if}
          {#if behind >= 2}<div class="deck-layer" data-layer="2"></div>{/if}
          {#if behind >= 1}<div class="deck-layer" data-layer="1"></div>{/if}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div bind:this={swipeCard} class="swipe-card"
            onpointerdown={onPointerDown} onpointermove={onPointerMove}
            onpointerup={onPointerUp} onpointercancel={() => { drag = null; resetCard(); }}>
            <canvas bind:this={canvas} class="meme-canvas"></canvas>
            <div class="swipe-tag" data-dir="funny">😂 FUNNY</div>
            <div class="swipe-tag" data-dir="meh">😐 NOT FUNNY</div>
            <div class="swipe-tag" data-dir="bad_context">🧠 WRONG IDEA</div>
            <div class="swipe-tag" data-dir="bad_structure">📐 STRUCTURAL</div>
            <button class={`act-btn ${faces.left.cls}`} data-pos="left"
              title={faces.left.label} aria-label={faces.left.label}
              onclick={() => trigger(actAt("left"))}><span class="ic">{faces.left.icon}</span></button>
            <button class={`act-btn ${faces.right.cls}`} data-pos="right"
              title={faces.right.label} aria-label={faces.right.label}
              onclick={() => trigger(actAt("right"))}><span class="ic">{faces.right.icon}</span></button>
            <button class={`act-btn ${faces.down.cls}`} data-pos="down"
              title={faces.down.label} aria-label={faces.down.label}
              onclick={() => trigger(actAt("down"))}><span class="ic">{faces.down.icon}</span></button>
            {#if problemMode}<div class="problem-prompt">⚠️ What's wrong with it?</div>{/if}
          </div>
        </div>
      </div>
    </div>
  {:else}
    <div class="empty">
      Nothing to rate — go to the <b>📚 Library</b> and hit <b>⚡ Generate 10</b> on an analyzed template.
    </div>
  {/if}
</section>

{#if reasonFlag}
  <ReasonSheet type={reasonFlag} onconfirm={reasonConfirm} onskip={reasonSkip} onclose={() => (reasonFlag = null)} />
{/if}
