<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { live } from "../lib/live.svelte";

  let videoEl = $state<HTMLVideoElement>();   // camera preview
  let audioEl = $state<HTMLAudioElement>();   // sound clips
  let clipVideoEl = $state<HTMLVideoElement>(); // video clips (V2)
  let started = $state(false);     // camera <video> mounted
  let countdown = $state(5);
  let clipTimer: ReturnType<typeof setTimeout> | undefined;

  onMount(() => void live.load());
  onDestroy(() => { clearTimeout(clipTimer); live.stop(); });

  async function enableCamera() {
    started = true;
    await tick();                  // ensure <video> is in the DOM
    if (videoEl) await live.startSensor(videoEl);
  }

  // Neutral baseline: a 5s relax countdown, then derive the resting smile.
  $effect(() => {
    if (live.phase !== "neutral") return;
    countdown = 5;
    const iv = setInterval(() => {
      countdown -= 1;
      if (countdown <= 0) { clearInterval(iv); live.endNeutral(); }
    }, 1000);
    return () => clearInterval(iv);
  });

  // Play the current clip (funny baseline + reels); video clips play in their own
  // <video> element with sound, sound clips in <audio>. A timer caps stalls.
  $effect(() => {
    const c = live.current;
    const phase = live.phase;
    if (!(phase === "funny" || phase === "reels") || !c) return;
    clearTimeout(clipTimer);
    if ((c.kind === "video" || c.kind === "remix") && clipVideoEl) {
      audioEl?.pause();
      clipVideoEl.src = c.file;
      clipVideoEl.currentTime = 0;
      clipVideoEl.volume = 0.85;
      clipVideoEl.play().catch(() => {});
    } else if (c.kind === "sound" && audioEl) {
      clipVideoEl?.pause();
      audioEl.src = c.file;
      audioEl.currentTime = 0;
      audioEl.volume = 0.8;          // gentle ceiling so nothing blasts
      audioEl.play().catch(() => {});
    } else {
      return; // element not mounted yet — effect re-runs when the ref binds
    }
    clipTimer = setTimeout(() => live.onClipEnded(), live.maxClipMs);
    return () => clearTimeout(clipTimer);
  });

  const smilePct = $derived(Math.round(live.smile * 100));
  const eqBars = [0, 1, 2, 3, 4, 5, 6];
</script>

<audio bind:this={audioEl} onended={() => live.onClipEnded()}></audio>

<section class="section live">
  <div class="page-head">
    <div>
      <h2 class="page-title">⚡ Live</h2>
      <div class="page-sub">real-time reels · your camera scores what makes you laugh</div>
    </div>
    {#if started}
      <div class="head-actions">
        <span class="cam-pill" class:on={live.sensorReady}>
          <span class="cam-dot"></span>{live.sensorReady ? "camera on · on-device" : live.status || "starting…"}
        </span>
      </div>
    {/if}
  </div>

  <!-- One persistent camera element: mounted the instant the user clicks (while
       still on the consent screen) so startSensor has a <video> to attach to. -->
  {#if started}
    <video bind:this={videoEl} autoplay muted playsinline class="cam-thumb" class:show={live.sensorReady}></video>
  {/if}

  <!-- ===== needs sounds ===== -->
  {#if live.phase === "needs-sounds"}
    <div class="live-card">
      <div class="live-emoji">🔊</div>
      <h3 class="live-h">Load a pool of funny clips</h3>
      <p class="live-p">
        Pulls the most-liked sound effects from myinstants and short funny videos from YouTube, and screens
        every one with Claude for safety (no slurs, sexual, graphic, or distressing content) before it can play.
      </p>
      <div class="live-btn-row">
        <button class="btn btn-primary" disabled={!!live.status && !live.error} onclick={() => live.harvest()}>
          🔊 Load sounds
        </button>
        <button class="btn" disabled={!!live.status && !live.error} onclick={() => live.harvestVideos()}>
          🎬 Load videos
        </button>
      </div>
      {#if live.status}<div class="live-status">{live.status}</div>{/if}
    </div>

  <!-- ===== consent ===== -->
  {:else if live.phase === "consent"}
    <div class="live-card">
      <div class="live-emoji">📷</div>
      <h3 class="live-h">Turn on your camera to find your laugh</h3>
      <p class="live-p">
        Meme Lab watches for your smile to score what's funny. <b>All face detection runs on your
        device</b> — frames never leave the browser, nothing is recorded, and only a smile number
        (0–100%) is used. You can stop anytime.
      </p>
      <div class="live-facts">
        <span>🟢 on-device only</span><span>🚫 no recording</span><span>📊 {live.sounds.length} safe clips ready</span>
      </div>
      <button class="btn btn-primary" onclick={enableCamera}>📷 Enable camera &amp; start</button>
      <button class="btn" disabled={!!live.status && !live.error} onclick={() => live.harvestVideos()}>🎬 Add funny videos first</button>
      {#if live.status}<div class="live-status">{live.status}</div>{/if}
    </div>

  <!-- ===== error ===== -->
  {:else if live.phase === "error"}
    <div class="live-card">
      <div class="live-emoji">⚠️</div>
      <h3 class="live-h">Camera couldn't start</h3>
      <p class="live-p">{live.error}</p>
      <button class="btn" onclick={() => { started = false; live.stop(); }}>← Back</button>
    </div>

  <!-- ===== calibration: neutral ===== -->
  {:else if live.phase === "neutral"}
    <div class="live-col">
      <h3 class="live-h">Relax your face…</h3>
      <p class="live-p">Setting your resting baseline. Just look at the screen normally.</p>
      <div class="countdown">{countdown}</div>
    </div>

  <!-- ===== calibration: funny baseline ===== -->
  {:else if live.phase === "funny"}
    <div class="live-col">
      <div class="reel">
        <div class="reel-eq" class:playing={true}>
          {#each eqBars as b (b)}<span style:animation-delay={`${b * 0.08}s`}></span>{/each}
        </div>
        <div class="reel-emoji" style:transform={`scale(${1 + live.smile * 0.4})`}>😂</div>
        <div class="reel-name">{live.current?.name ?? "…"}</div>
      </div>
      <h3 class="live-h">Warm-up — react however you naturally would</h3>
      <p class="live-p">Learning your laugh range · clip {live.calStep}/{live.calTotal}</p>
      <div class="smile-row">
        <span class="smile-lbl">smile</span>
        <div class="smile-bar"><div style:width={`${smilePct}%`}></div></div>
        <span class="smile-pct">{smilePct}%</span>
      </div>
    </div>

  <!-- ===== reels ===== -->
  {:else if live.phase === "reels"}
    <div class="live-grid">
      <div class="live-col">
        {#if live.generatingRemix}
          <div class="live-card">
            <div class="live-emoji">✨</div>
            <h3 class="live-h">Creating your remix feed…</h3>
            <p class="live-p">Evaluation done — fusing your funniest sounds × videos into fresh memes.</p>
            {#if live.status}<div class="live-status">{live.status}</div>{/if}
          </div>
        {:else if live.resetting}
          <div class="reset-screen">
            <div class="reset-emoji">😐</div>
            <div class="reset-text">back to neutral…</div>
          </div>
        {:else if live.current}
          <div class="reel">
            {#if live.current.kind === "video" || live.current.kind === "remix"}
              <video bind:this={clipVideoEl} class="reel-video" playsinline
                onended={() => live.onClipEnded()}></video>
              {#if live.current.caption}
                {#if live.current.caption.top}<div class="meme-cap meme-cap-top">{live.current.caption.top}</div>{/if}
                {#if live.current.caption.bottom}<div class="meme-cap meme-cap-bottom">{live.current.caption.bottom}</div>{/if}
              {/if}
              {#if live.current.kind === "remix"}<div class="remix-badge">✨ remix</div>{/if}
              <div class="reel-name reel-name-over">{live.current.name}</div>
            {:else}
              <div class="reel-eq" class:playing={!live.reacting}>
                {#each eqBars as b (b)}<span style:animation-delay={`${b * 0.08}s`}></span>{/each}
              </div>
              <div class="reel-emoji" style:transform={`scale(${1 + live.smile * 0.5})`}>
                {live.smile > 0.55 ? "🤣" : live.smile > 0.25 ? "😄" : "🙂"}
              </div>
              <div class="reel-name">{live.current.name}</div>
              {#if live.current.tags.length}
                <div class="reel-tags">{#each live.current.tags as t (t)}<span>{t}</span>{/each}</div>
              {/if}
            {/if}
            <!-- live laugh score — hidden in the live feed so it can't bias the reaction -->
            {#if !live.remixOnly}
              <div class="reel-score">
                <div class="reel-score-bar"><div style:width={`${Math.round(live.liveScore * 100)}%`}></div></div>
                <div class="reel-score-num">{Math.round(live.liveScore * 100)}</div>
              </div>
            {/if}
          </div>

          <div class="reel-actions">
            <span class="smile-mini">
              {#if live.reacting}<span class="reacting">👂 reading your reaction…</span>
              {:else if live.remixOnly}📷 camera reading{#if !live.faceVisible} · <span class="warn">no face</span>{/if}
              {:else}😶 smile {smilePct}%{#if !live.faceVisible} · <span class="warn">no face</span>{/if}{/if}
            </span>
            <span class="reel-btns">
              {#if live.current.kind === "video" || live.current.kind === "remix"}
                <a class="btn" href={live.current.file} download={`${live.current.id}.mp4`}>⬇ save</a>
              {/if}
              <button class="btn" onclick={() => live.skip()}>skip →</button>
            </span>
          </div>
          <div class="reel-stat">
            {#if live.remixOnly}
              ✨ remix feed · {live.sessionPlays} rated
            {:else}
              evaluating · {live.rawRated}/{live.evalTarget} rated
              {#if live.canRemix} · <button class="linkbtn" onclick={() => live.remix()}>✨ remix now</button>{/if}
            {/if}
          </div>
        {:else}
          <div class="live-card">
            <div class="live-emoji">🎉</div>
            <h3 class="live-h">Pool exhausted</h3>
            <p class="live-p">Load more clips to keep the feed going.</p>
            <div class="live-btn-row">
              <button class="btn btn-primary" onclick={() => live.harvest()}>🔊 More sounds</button>
              <button class="btn" onclick={() => live.harvestVideos()}>🎬 More videos</button>
              {#if live.canRemix}<button class="btn" onclick={() => live.remix()}>✨ Remix</button>{/if}
            </div>
            {#if live.status}<div class="live-status">{live.status}</div>{/if}
          </div>
        {/if}
      </div>

      <!-- live leaderboard -->
      <aside class="live-board">
        <div class="live-board-head">🏆 funniest so far</div>
        {#if live.board.length}
          {#each live.board as s, i (s.id)}
            <div class="lb-row">
              <span class="lb-rank">{i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`}</span>
              <span class="lb-name">{s.name}</span>
              {#if !live.remixOnly}<span class="lb-score">{Math.round(s.score * 100)}</span>{/if}
            </div>
          {/each}
        {:else}
          <div class="lb-empty">react to a few clips to build the board</div>
        {/if}
      </aside>
    </div>
  {/if}
</section>
