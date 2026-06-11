// Central reactive store (Svelte 5 runes). All UI is derived from this state;
// components mutate it through the action methods below.
import { api } from "./api";
import type {
  AppState, Fighter, ImgflipItem, QueueItem, Rating, View,
} from "./types";

const RATING_LABEL: Record<Rating, string> = {
  funny: "😂 Funny",
  meh: "😐 Not funny",
  bad_context: "🧠 wrong idea",
  bad_structure: "📐 structural fail",
};

// How many candidates the auto-pipeline generates per template — small batches
// keep rating sessions short and varied so you don't go numb to one template.
const AUTO_GENERATE_COUNT = 3;

/** In-place Fisher–Yates shuffle. */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

class Store {
  view = $state<View>("library");
  app = $state<AppState>({ templates: [], busy: null, harvested: 0 });
  queue = $state<QueueItem[]>([]);
  ratedThisSession = $state(0);
  duelPair = $state<[Fighter, Fighter] | null>(null);
  board = $state<Fighter[]>([]);
  imgflip = $state<ImgflipItem[]>([]);
  status = $state("");
  locked = $state(false); // server-busy UI lock for job buttons

  // app-level modals
  seedOpen = $state(false);
  lightboxIndex = $state<number | null>(null);

  #busyWatch = false;

  /** The candidate currently being rated — head of the queue. */
  get current(): QueueItem | null {
    return this.queue[0] ?? null;
  }

  init(): void {
    void this.refresh();
    void this.loadImgflip();
    // idle poll: only when the rating queue is empty so it can't clobber an
    // in-progress rating session.
    setInterval(() => {
      if (!this.current) void this.refresh();
    }, 30_000);
  }

  /** Group pending candidates by template, shuffle within each, then round-robin
   *  across templates so consecutive cards rarely share a template — keeps the
   *  rater from going numb to one meme. */
  buildQueue(): void {
    const groups = this.app.templates
      .map((t) => t.pending.map((c): QueueItem => ({
        slug: t.slug, name: t.name, blank_url: t.blank_url, box_layout: t.box_layout, candidate: c,
      })))
      .filter((g) => g.length)
      .map((g) => shuffle(g));
    shuffle(groups); // randomize which template leads

    const q: QueueItem[] = [];
    for (let more = true; more; ) {
      more = false;
      for (const g of groups) {
        const item = g.shift();
        if (item) { q.push(item); more = true; }
      }
    }
    this.queue = q;
  }

  async refresh(): Promise<void> {
    this.app = await api<AppState>("/api/state");
    this.buildQueue();
    void this.loadDuel();
    void this.loadLeaderboard();
    this.watchBusy();
  }

  /** If a job holds the server, lock job buttons and poll until it frees up. */
  watchBusy(): void {
    if (this.app.busy) {
      this.#busyWatch = true;
      this.locked = true;
      this.status = `⏳ Server busy: ${this.app.busy}… buttons unlock when it finishes`;
      setTimeout(() => void this.refresh(), 3000);
    } else if (this.#busyWatch) {
      this.#busyWatch = false;
      this.locked = false;
      this.status = "Server free again — carry on.";
    }
  }

  /* ---------------------------------------------------------- library jobs */

  async doJob(path: string, msg: string): Promise<void> {
    this.status = msg;
    this.locked = true;
    try {
      await api(path, { method: "POST", body: {} });
      this.status = "Done.";
      if (path.includes("/api/generate/")) this.view = "rate"; // fresh candidates
    } catch (e) {
      const m = (e as Error).message;
      this.status = m.startsWith("Busy:")
        ? `⏳ ${m.replace("Busy:", "Server is already working on")} — will auto-refresh when done.`
        : `Error: ${m}`;
    } finally {
      this.locked = false;
      void this.refresh();
    }
  }

  async seed(name: string): Promise<void> {
    this.status = `Seeding "${name}" from imgflip + transcribing with Claude vision…`;
    this.locked = true;
    try {
      const r = await api<{ seeded: number; template: string; total: number }>(
        "/api/seed", { method: "POST", body: { name } });
      this.status = `Seeded ${r.seeded} examples of "${r.template}" — now ${r.total} total.`;
    } catch (e) {
      this.status = `Seed error: ${(e as Error).message}`;
    } finally {
      this.locked = false;
      void this.refresh();
    }
  }

  /** Full hands-off lifecycle for each selected template:
   *  seed → analyze → generate, sequentially. Lands on the Rate view when done. */
  async autoPipeline(names: string[]): Promise<void> {
    if (!names.length) return;
    this.locked = true;
    let ready = 0;
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const tag = `(${i + 1}/${names.length}) "${name}"`;
      try {
        this.status = `🌱 ${tag}: seeding example memes from imgflip + Claude vision…`;
        await api("/api/seed", { method: "POST", body: { name } });

        // refetch to resolve the slug + example count the server assigned
        this.app = await api<AppState>("/api/state");
        const tpl = this.app.templates.find((t) => t.name === name);
        if (!tpl) { this.status = `Skipped "${name}" — seeding produced no template.`; continue; }
        if (tpl.examples < tpl.min_examples) {
          this.status = `⚠️ "${name}" only got ${tpl.examples}/${tpl.min_examples} examples — seeded but can't analyze yet.`;
          continue;
        }

        if (!tpl.analyzed) {
          this.status = `🔬 ${tag}: analyzing how the template works…`;
          await api(`/api/analyze/${tpl.slug}`, { method: "POST", body: {} });
        }

        this.status = `⚡ ${tag}: generating ${AUTO_GENERATE_COUNT} candidates to rate…`;
        await api(`/api/generate/${tpl.slug}`, { method: "POST", body: { count: AUTO_GENERATE_COUNT } });
        ready++;
      } catch (e) {
        this.status = `Pipeline error on "${name}": ${(e as Error).message}`;
      }
    }
    this.locked = false;
    await this.refresh();
    this.status = `✅ Ready to rate — ${ready}/${names.length} template(s) seeded, analyzed & generated.`;
    if (this.queue.length) this.view = "rate";
  }

  async harvest(): Promise<void> {
    this.status = "Harvesting top memes + Claude vision template identification — this takes a few minutes…";
    this.locked = true;
    try {
      const r = await api<{ byTemplate?: Record<string, number>; new_images: number; templated: number }>(
        "/api/harvest", { method: "POST", body: { max: 30 } });
      const top = Object.entries(r.byTemplate ?? {})
        .sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([n, c]) => `${n} +${c}`).join(", ");
      this.status = `Harvest done: ${r.new_images} new images, ${r.templated} filed into templates. ${top ? "Top: " + top : ""}`;
    } catch (e) {
      this.status = `Harvest error: ${(e as Error).message}`;
    } finally {
      this.locked = false;
      void this.refresh();
    }
  }

  async loadImgflip(): Promise<void> {
    if (this.imgflip.length) return;
    try {
      this.imgflip = await api<ImgflipItem[]>("/api/imgflip");
    } catch { /* non-fatal */ }
  }

  /* ---------------------------------------------------------------- rating */

  /** Optimistically advance so the card flow feels instant; resync on error. */
  async commitRating(rating: Rating, reason: string, image: string): Promise<void> {
    const item = this.current;
    if (!item) return;
    this.queue.shift();
    this.ratedThisSession++;
    this.status = `${RATING_LABEL[rating]} — ${item.name}${reason ? ` · “${reason}”` : ""}`;
    try {
      await api("/api/rate", {
        method: "POST",
        body: { slug: item.slug, id: item.candidate.id, rating, image, reason },
      });
      // refresh library counts without rebuilding the optimistic queue
      api<AppState>("/api/state").then((s) => { this.app = s; }).catch(() => {});
      if (rating === "funny") { void this.loadDuel(); void this.loadLeaderboard(); }
    } catch (e) {
      this.status = `Rating error: ${(e as Error).message} — resyncing…`;
      void this.refresh();
    }
  }

  /* ---------------------------------------------------------------- duels */

  async loadDuel(force = false): Promise<void> {
    // Don't re-roll a matchup that's already on screen during background polls.
    if (!force && this.duelPair) return;
    try {
      const { pair } = await api<{ pair: [Fighter, Fighter] | null }>("/api/duel");
      this.duelPair = pair;
    } catch { /* non-fatal */ }
  }

  async vote(winnerIdx: 0 | 1): Promise<void> {
    if (!this.duelPair) return;
    const winner = this.duelPair[winnerIdx];
    const loser = this.duelPair[1 - winnerIdx];
    try {
      const r = await api<{ winnerElo: number; loserElo: number }>("/api/duel", {
        method: "POST",
        body: {
          winner: { slug: winner.slug, id: winner.id },
          loser: { slug: loser.slug, id: loser.id },
        },
      });
      this.status = `Winner climbs to elo ${r.winnerElo}, loser drops to ${r.loserElo}.`;
      void this.loadDuel(true);
      void this.loadLeaderboard();
    } catch (e) {
      this.status = `Duel error: ${(e as Error).message}`;
    }
  }

  /* ---------------------------------------------------------- leaderboard */

  async loadLeaderboard(): Promise<void> {
    try {
      this.board = await api<Fighter[]>("/api/leaderboard");
    } catch { /* non-fatal */ }
  }
}

export const store = new Store();
