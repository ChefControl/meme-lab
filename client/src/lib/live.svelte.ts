// Meme Lab Live — client store (Svelte 5 runes).
//
// Orchestrates the laugh loop: load a safety-screened sound pool, get camera
// consent, calibrate the user's smile range on-device, then run the reels feed
// where each sound's live laugh reward trains the recommender.
import { api } from "./api";
import { LaughSensor, normalize, neutralFrom, scaleFrom, DEFAULT_CAL, type Calibration } from "./laugh";
import type { Sound } from "./types";

export type Phase = "needs-sounds" | "consent" | "neutral" | "funny" | "reels" | "error";

const CALIBRATION_CLIPS = 5; // how many known-funny sounds the funny baseline plays
const MAX_CLIP_MS = 13000;   // stall safety; above the 12s video length so clips play full
const EVAL_TARGET = 20;      // raw clips to rate before the feed switches to remixes only
const REMIX_BATCH = 12;      // remixes generated when entering remix mode / refilling
const MIN_WATCH_MS = 2600;   // give a clip this long to land a laugh before we cut it
const NOT_SMILING = 0.12;    // smile below this = not laughing → cut + penalize

// Reaction-time handling — a laugh lands a beat AFTER the sound, so attribution
// has to account for human reaction lag (~0.3–1.5s), especially on short clips.
const REACTION_GRACE_MS = 350;  // ignore the clip's first moments (residual smile from the previous one)
const REACTION_TAIL_MS = 1500;  // after audio ends, keep crediting THIS clip this long
const TAIL_MIN_MS = 350;        // always hold at least this long to catch the laugh's onset
const TAIL_RELEASE = 0.12;      // once the smile has subsided, the tail can close early

class LiveStore {
  phase = $state<Phase>("needs-sounds");
  sounds = $state<Sound[]>([]);
  board = $state<Sound[]>([]);
  current = $state<Sound | null>(null);
  smile = $state(0);          // live normalized smile 0..1
  liveScore = $state(0);      // accumulating reward for the current clip 0..1
  faceVisible = $state(false);
  sensorReady = $state(false);
  sessionPlays = $state(0);
  reacting = $state(false);           // in the post-clip reaction window (UI hint)
  rawRated = $state(0);               // raw (non-remix) clips rated this session
  remixOnly = $state(false);          // post-evaluation: feed serves only remixes
  generatingRemix = $state(false);    // a remix batch is being created
  status = $state("");
  error = $state("");
  readonly evalTarget = EVAL_TARGET;
  cal = $state<Calibration>({ ...DEFAULT_CAL });
  calStep = $state(0);                 // funny-baseline progress
  calTotal = $state(CALIBRATION_CLIPS);

  private sensor = new LaughSensor();
  private raf = 0;
  private recent: string[] = [];
  private calSamples: number[] = [];
  private calibrating: null | "neutral" | "funny" = null;
  private capturing = false;
  private rewardPeak = 0;
  private rewardSum = 0;
  private rewardN = 0;
  private funnyQueue: Sound[] = [];
  private clipStartedAt = 0;          // performance.now() when the current clip began
  private audioEnded = false;         // audio finished; reaction tail is now running
  private clipEndedAt = 0;            // when the audio ended (tail start)
  private playedIds = new Set<string>(); // clips seen this session (for first-play-full-length)
  private currentIsRepeat = false;    // current clip has been played before this session

  get hasSounds(): boolean { return this.sounds.length > 0; }

  async load(): Promise<void> {
    try {
      const { sounds } = await api<{ sounds: Sound[] }>("/api/live/sounds");
      this.sounds = sounds;
      if (this.phase === "needs-sounds" && sounds.length) this.phase = "consent";
      if (!sounds.length) this.phase = "needs-sounds";
      void this.loadBoard();
    } catch (e) { this.error = (e as Error).message; }
  }

  async loadBoard(): Promise<void> {
    try { this.board = await api<Sound[]>("/api/live/leaderboard"); } catch { /* non-fatal */ }
  }

  async harvest(): Promise<void> {
    this.status = "Pulling the most-liked sound effects + screening each for safety…";
    try {
      const r = await api<{ added: number; rejected: number; total: number }>(
        "/api/live/harvest", { method: "POST", body: { max: 60 } });
      this.status = `Added ${r.added} safe sounds (${r.rejected} rejected). Pool: ${r.total}.`;
      await this.load();
      if (this.sounds.length) this.phase = "consent";
    } catch (e) { this.status = `Harvest error: ${(e as Error).message}`; }
  }

  async harvestVideos(): Promise<void> {
    this.status = "Pulling funny YouTube clips, downloading + screening each frame…";
    try {
      const r = await api<{ added: number; rejected: number; total: number }>(
        "/api/live/harvest-videos", { method: "POST", body: { max: 20 } });
      this.status = `Added ${r.added} safe videos (${r.rejected} rejected). Pool: ${r.total}.`;
      await this.load();
      if (this.sounds.length) this.phase = "consent";
    } catch (e) { this.status = `Video harvest error: ${(e as Error).message}`; }
  }

  // Remix needs at least one video and one sound to fuse.
  get canRemix(): boolean {
    return this.sounds.some((s) => s.kind === "sound") &&
      this.sounds.some((s) => s.kind === "video" || s.kind === "remix");
  }

  async remix(count = 4): Promise<void> {
    this.status = "Fusing your top sounds × videos into new remixes…";
    try {
      const r = await api<{ added: number; total: number }>(
        "/api/live/remix", { method: "POST", body: { count } });
      this.status = `Created ${r.added} remixes. Pool: ${r.total}.`;
      await this.load();
    } catch (e) { this.status = `Remix error: ${(e as Error).message}`; }
  }

  /* ------------------------------------------------------ sensor + loop */

  /** Start the on-device sensor against a <video>. Camera first (instant prompt),
   *  then the model. Throws surface as the error phase. */
  async startSensor(video: HTMLVideoElement): Promise<void> {
    try {
      this.status = "Requesting camera…";
      await this.sensor.startCamera(video);     // permission prompt fires here
      this.status = "Loading on-device face model…";
      await this.sensor.loadModel();
      this.sensorReady = true;
      this.status = "";
      this.loop();
      this.beginNeutral();
    } catch (e) {
      this.error = (e as Error).message || "Camera unavailable.";
      this.status = "";
      this.phase = "error";
    }
  }

  private loop = (): void => {
    const raw = this.sensor.sampleRaw();
    this.faceVisible = this.sensor.faceVisible;
    const now = performance.now();
    if (raw !== null) {
      const s = normalize(raw, this.cal);
      this.smile = s;
      if (this.calibrating) this.calSamples.push(raw);
      // Only credit the clip after the grace period — the first ~350ms is either
      // residual smile from the previous clip or too soon to be a reaction to this one.
      if (this.capturing && now - this.clipStartedAt >= REACTION_GRACE_MS) {
        this.rewardPeak = Math.max(this.rewardPeak, s);
        this.rewardSum += s; this.rewardN += 1;
        this.liveScore = Math.max(0, Math.min(1, 0.6 * this.rewardPeak + 0.4 * (this.rewardSum / this.rewardN)));
      }
    }
    // Reaction tail: after the audio ends, keep crediting THIS clip until the laugh
    // subsides or the max tail elapses — so a delayed laugh isn't pinned on the next clip.
    if (this.capturing && this.audioEnded) {
      const tail = now - this.clipEndedAt;
      const subsided = this.smile < TAIL_RELEASE;
      if (tail >= REACTION_TAIL_MS || (tail >= TAIL_MIN_MS && subsided)) {
        void this.finalizeReels();
      }
    }
    // Aggressive cut — only AFTER evaluation and only on a REPLAY: first plays
    // always run full length (even with no smile); a clip you've already seen that
    // still isn't landing gets cut short.
    if (this.capturing && !this.audioEnded && this.remixOnly && this.currentIsRepeat
        && now - this.clipStartedAt >= MIN_WATCH_MS && this.rewardPeak < NOT_SMILING) {
      void this.cutForNoSmile();
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  /* ------------------------------------------------------ calibration */

  private beginNeutral(): void {
    this.calSamples = []; this.calibrating = "neutral"; this.phase = "neutral";
  }
  /** Called by the UI after the relax countdown. */
  endNeutral(): void {
    this.cal = { ...this.cal, neutral: neutralFrom(this.calSamples) };
    this.calibrating = null;
    this.beginFunny();
  }

  private beginFunny(): void {
    this.calSamples = [];
    // Calibration uses sound clips only (the warm-up UI is a sound card); fall back
    // to anything if the pool is video-only.
    const soundsOnly = this.sounds.filter((s) => s.kind === "sound");
    const pool = soundsOnly.length ? soundsOnly : this.sounds;
    if (!pool.length) { this.startReels(); return; }
    this.calibrating = "funny";
    this.phase = "funny";
    this.funnyQueue = [...pool].sort(() => Math.random() - 0.5).slice(0, CALIBRATION_CLIPS);
    this.calTotal = this.funnyQueue.length;
    this.calStep = 1;
    this.current = this.funnyQueue.shift() ?? null;
  }
  /** Funny baseline plays a few known-funny clips; advance through them. */
  private advanceFunny(): void {
    const next = this.funnyQueue.shift();
    if (next) { this.current = next; this.calStep += 1; return; }
    // done — derive the user's laugh scale, then start the real feed
    this.cal = { ...this.cal, scale: scaleFrom(this.calSamples, this.cal.neutral) };
    this.calibrating = null;
    this.startReels();
  }

  /* ------------------------------------------------------ reels loop */

  private startCapture(): void {
    this.rewardPeak = 0; this.rewardSum = 0; this.rewardN = 0; this.liveScore = 0;
    this.capturing = true;
    this.clipStartedAt = performance.now();
    this.audioEnded = false; this.clipEndedAt = 0; this.reacting = false;
  }

  /** Pick the next clip. During evaluation: raw sounds+videos. After: remixes only. */
  async pickNext(): Promise<boolean> {
    const kinds = this.remixOnly ? ["remix"] : ["sound", "video"];
    try {
      const { sound } = await api<{ sound: Sound | null }>(
        "/api/live/next", { method: "POST", body: { exclude: this.recent, kinds } });
      this.current = sound;
      if (sound) {
        this.currentIsRepeat = this.playedIds.has(sound.id); // first play vs replay
        this.recent = [sound.id, ...this.recent].slice(0, 16);
        this.startCapture();
        return true;
      }
      return false;
    } catch (e) { this.status = `Feed error: ${(e as Error).message}`; return false; }
  }

  /** Pick next; in remix mode, top up remixes first if the feed runs dry. */
  private async ensureNext(): Promise<void> {
    if (await this.pickNext()) return;
    if (this.remixOnly && !this.generatingRemix && this.canRemix) {
      this.generatingRemix = true;
      try { await this.remix(REMIX_BATCH); } finally { this.generatingRemix = false; }
      await this.pickNext();
    }
  }

  /** Start the reels feed in evaluation mode. */
  private startReels(): void {
    this.phase = "reels";
    this.remixOnly = false;
    this.rawRated = 0;
    this.recent = [];
    this.playedIds.clear();
    this.currentIsRepeat = false;
    void this.ensureNext();
  }

  /** After the first evaluation pass, fuse the top picks and flip to a remix-only feed. */
  private async enterRemixMode(): Promise<void> {
    this.generatingRemix = true;
    try { await this.remix(REMIX_BATCH); } finally { this.generatingRemix = false; }
    this.remixOnly = true;
    this.recent = [];
    await this.ensureNext();
  }

  /** Route the feed after each rating: trigger the eval→remix switch or just advance. */
  private async afterCommit(): Promise<void> {
    if (!this.remixOnly && this.canRemix && this.rawRated >= EVAL_TARGET) {
      await this.enterRemixMode();
    } else {
      await this.ensureNext();
    }
  }

  private async commitReward(skipped: boolean): Promise<void> {
    const sound = this.current;
    if (!sound || !this.capturing) return;
    this.capturing = false;
    this.playedIds.add(sound.id); // seen this session → eligible for a cut on replay
    const auc = this.rewardN ? this.rewardSum / this.rewardN : 0;
    let reward = 0.6 * this.rewardPeak + 0.4 * auc;
    if (skipped) reward *= 0.4; // early skip = weak/negative signal
    if (this.rewardPeak < NOT_SMILING) reward = 0; // no smile at all → fully penalized
    reward = Math.max(0, Math.min(1, reward));
    // optimistic local update so the leaderboard feels live
    sound.plays += 1; sound.reward_sum += reward; sound.score = sound.reward_sum / sound.plays;
    sound.best = Math.max(sound.best, reward);
    this.sessionPlays += 1;
    if (sound.kind !== "remix") this.rawRated += 1; // counts toward the first-evaluation target
    try {
      await api("/api/live/score", { method: "POST", body: { id: sound.id, reward } });
      void this.loadBoard();
    } catch (e) { this.status = `Score error: ${(e as Error).message}`; }
  }

  /** The UI calls this when the current clip's audio finishes (or hits the cap).
   *  For reels we don't advance yet — we open the reaction window and let the loop
   *  finalize once the (possibly delayed) laugh has registered. */
  onClipEnded(): void {
    if (this.phase === "funny") { this.advanceFunny(); return; }
    if (this.phase === "reels" && this.capturing && !this.audioEnded) {
      this.audioEnded = true;
      this.clipEndedAt = performance.now();
      this.reacting = true;
    }
  }

  /** Close out a reels clip after its reaction window, then queue the next. */
  private async finalizeReels(): Promise<void> {
    if (!this.capturing) return;
    this.reacting = false;
    await this.commitReward(false);
    await this.afterCommit();
  }

  /** Cut a clip that isn't landing (no smile by MIN_WATCH) — penalized, advance fast. */
  private async cutForNoSmile(): Promise<void> {
    if (!this.capturing) return;
    this.reacting = false;
    await this.commitReward(true); // reward floors to 0 (no smile) → penalized
    await this.afterCommit();
  }

  /** Reels-only: skip the current clip immediately (weak signal, no reaction tail). */
  skip(): void {
    if (this.phase !== "reels" || !this.capturing) return;
    this.reacting = false;
    void this.commitReward(true).then(() => this.afterCommit());
  }

  get maxClipMs(): number { return MAX_CLIP_MS; }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.sensor.stop();
    this.sensorReady = false;
    this.capturing = false;
    this.calibrating = null;
    this.current = null;
    this.smile = 0; this.liveScore = 0;
    this.remixOnly = false; this.rawRated = 0; this.generatingRemix = false;
    this.playedIds.clear(); this.currentIsRepeat = false;
    if (this.phase !== "needs-sounds") this.phase = this.hasSounds ? "consent" : "needs-sounds";
  }
}

export const live = new LiveStore();
