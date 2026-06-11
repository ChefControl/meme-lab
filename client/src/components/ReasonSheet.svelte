<script lang="ts">
  import type { Rating } from "../lib/types";

  let { type, onconfirm, onskip, onclose }: {
    type: Rating;
    onconfirm: (reason: string) => void;
    onskip: () => void;
    onclose: () => void;
  } = $props();

  const PRESETS: Record<string, string[]> = {
    bad_context: [
      "misses the core idea", "literal — no tension/contrast",
      "wrong subject for this template", "ignores the setup", "joke is off-template",
    ],
    bad_structure: [
      "caption hides the meme", "caption mispositioned", "too long / overflows the box",
      "wrong number of labels", "boxes merged or swapped", "text unreadable",
    ],
  };

  let chosen = $state<Set<string>>(new Set());
  let note = $state("");

  const title = $derived(type === "bad_context" ? "🧠 What's the wrong idea?" : "📐 What's the structural fail?");
  const hint = $derived(type === "bad_context"
    ? "Pick what this caption gets wrong about the template's idea — it sharpens the next analysis."
    : "Pick how this caption breaks the template's structure — it hardens the structural rules.");

  function toggle(r: string) {
    const s = new Set(chosen);
    s.has(r) ? s.delete(r) : s.add(r);
    chosen = s;
  }
  function confirm() {
    onconfirm([...chosen, note.trim()].filter(Boolean).join("; "));
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="modal" onclick={(e) => e.currentTarget === e.target && onclose()}>
  <div class="reason-box">
    <h2>{title}</h2>
    <p class="modal-hint">{hint}</p>
    <div class="reason-chips">
      {#each PRESETS[type] as r (r)}
        <div class="reason-chip" class:on={chosen.has(r)} role="button" tabindex="0"
          onclick={() => toggle(r)}
          onkeydown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle(r))}>{r}</div>
      {/each}
    </div>
    <input class="reason-extra" bind:value={note} type="text" placeholder="add a note (optional)" autocomplete="off" />
    <div class="modal-foot">
      <span class="spacer"></span>
      <button class="secondary" onclick={onskip}>flag without reason</button>
      <button class="flag-confirm" onclick={confirm}>Confirm flag</button>
    </div>
  </div>
</div>
