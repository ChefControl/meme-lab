// Meme Lab Live — sound-reels backend.
// Harvests most-liked sound effects from myinstants, screens each for safety
// with Claude (falling back to a keyword blocklist if the API is unavailable),
// and serves a laugh-driven reels loop: a Thompson-sampling picker chooses what
// to play next, and per-sound laugh rewards train a lightweight humor profile.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import "dotenv/config";

import { client, MODEL, jsonFrom } from "./claude.js";
import { DATA, loadJSON, saveJSON, slugify } from "./store.js";

const SOUNDS_DIR = path.join(DATA, "sounds");
const AUDIO_DIR = path.join(SOUNDS_DIR, "audio");
const VIDEO_DIR = path.join(SOUNDS_DIR, "video");
const INDEX = path.join(SOUNDS_DIR, "index.json");
const PROFILE = path.join(SOUNDS_DIR, "profile.json");

const execFileP = promisify(execFile);

// Safety moderation is simple classification — use a cheap/fast model, not Opus,
// since we run it across hundreds of clips. Opus stays for creative remix pairing.
const SCREEN_MODEL = "claude-haiku-4-5-20251001";
const MI_UA = { "User-Agent": "Mozilla/5.0 MemeLabLive/1.0" };
const VIDEO_CONCURRENCY = 4; // parallel yt-dlp downloads + screens

/** Run an async fn over items with a bounded worker pool. */
async function mapPool<T, R>(items: T[], concurrency: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let idx = 0;
  const worker = async () => {
    while (idx < items.length) {
      const i = idx++;
      try { out[i] = await fn(items[i], i); } catch { /* leave undefined */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

const MYINSTANTS = "https://www.myinstants.com";
// Most-liked sound effects (the category + region the user pointed at).
const SOURCE_PAGE = `${MYINSTANTS}/en/categories/sound%20effects/us/`;

// "Sound" is the historical name; as of V2 a clip can be kind "video" too. The
// reels feed, picker, scoring, and leaderboard all treat both kinds uniformly.
export interface Sound {
  id: string;
  kind: "sound" | "video" | "remix";
  name: string;
  source_url: string;   // origin media URL (myinstants mp3, youtube watch url, or "remix://")
  file: string;         // same-origin served path: /data/sounds/audio|video/<id>.<ext>
  duration?: number;    // seconds (videos)
  caption?: { top: string; bottom: string }; // remix meme text, rendered as an overlay
  parents?: { video: string; sound: string }; // remix provenance
  tags: string[];       // humor tags (slapstick, meme, animal, gross, …)
  flags: string[];      // safety flags surfaced to the sensitivity filter (e.g. "loud")
  safety: "approved" | "rejected";
  reject_reason?: string;
  // live scoring
  plays: number;
  reward_sum: number;
  score: number;        // running mean laugh reward, 0..1
  best: number;         // best single reward seen
  created_at: string;
}

interface HumorProfile {
  tag_affinity: Record<string, { sum: number; n: number }>;
  total_plays: number;
  updated_at: string;
}

/* ----------------------------------------------------------------- storage */

function loadSounds(): Sound[] {
  // Migrate pre-V2 records that predate the `kind` field.
  return loadJSON<Sound[]>(INDEX, []).map((s) => ({ ...s, kind: s.kind ?? "sound" }));
}
function saveSounds(s: Sound[]): void { saveJSON(INDEX, s); }
function loadProfile(): HumorProfile {
  return loadJSON<HumorProfile>(PROFILE, { tag_affinity: {}, total_plays: 0, updated_at: "" });
}

/** Approved pool only — the never-show-unsafe-content guarantee lives here. */
export function listSounds(): Sound[] {
  return loadSounds().filter((s) => s.safety === "approved");
}

export function leaderboard(limit = 20): Sound[] {
  return listSounds()
    .filter((s) => s.plays > 0)
    .sort((a, b) => b.score - a.score || b.best - a.best)
    .slice(0, limit);
}

/* ------------------------------------------------------------- safety gate */

// Hard blocklist applied even before Claude — keeps obviously unsafe titles out
// if the moderation call fails. Not exhaustive; Claude does the nuanced pass.
const BLOCK = /\b(n[i1]gg|f[a@]gg|r[a@]pe|rape|kill\s*your|suicide|porn|sex|nazi|hitler|slur)\b/i;
const LOUD = /\b(airhorn|air horn|horn|scream|screaming|siren|alarm|explosion|gun|gunshot|loud|earrape|ear rape|bang)\b/i;

interface Verdict { name: string; safe: boolean; reason?: string; tags: string[]; loud: boolean }

function keywordVerdict(name: string): Verdict {
  return {
    name,
    safe: !BLOCK.test(name),
    reason: BLOCK.test(name) ? "blocked keyword" : undefined,
    tags: [],
    loud: LOUD.test(name),
  };
}

/** Claude screens a batch of sound names for safety + humor tags + loudness. */
async function screen(names: string[]): Promise<Map<string, Verdict>> {
  const out = new Map<string, Verdict>();
  if (!process.env.ANTHROPIC_API_KEY) {
    for (const n of names) out.set(n, keywordVerdict(n));
    return out;
  }
  // Chunk so a big batch can't blow the output token budget.
  for (let i = 0; i < names.length; i += 40) {
    const chunk = names.slice(i, i + 40);
    try {
      const res = await client.messages.create({
        model: SCREEN_MODEL,
        max_tokens: 4000,
        messages: [{
          role: "user",
          content:
            "You are screening short sound-effect clip titles for a humor app. " +
            "For EACH title return a JSON object. Mark safe=false if the title indicates " +
            "slurs, hate, sexual/graphic content, self-harm, or content likely to distress. " +
            "Set loud=true for startling/jump-scare/very-loud sounds (airhorn, scream, siren, " +
            "alarm, explosion, gunshot, ear-rape). Add 1-3 humor `tags` from: " +
            "[slapstick, meme, animal, gross, wholesome, absurd, voice, music, fail, classic]. " +
            'Return ONLY a JSON array: [{"name":"<exact title>","safe":true,"reason":"",' +
            '"tags":["meme"],"loud":false}, ...].\n\nTitles:\n' +
            chunk.map((n, k) => `${k + 1}. ${n}`).join("\n"),
        }],
      });
      const arr = jsonFrom<Verdict[]>(res);
      for (const v of arr) if (v && v.name) out.set(v.name, v);
    } catch (e) {
      console.error("[live] moderation chunk failed, keyword fallback:", (e as Error).message);
    }
  }
  // Anything Claude didn't return a verdict for → keyword fallback.
  for (const n of names) if (!out.has(n)) out.set(n, keywordVerdict(n));
  return out;
}

/* --------------------------------------------------------------- harvest */

interface Scraped { name: string; url: string }

/** Parse most-liked instants out of a myinstants category page. */
function parsePage(html: string): Scraped[] {
  const re = /play\('(\/media\/sounds\/[^']+?\.mp3)'[\s\S]*?instant-link[^>]*>([^<]+)<\/a>/g;
  const found: Scraped[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const url = MYINSTANTS + m[1];
    const name = decodeEntities(m[2].trim());
    if (name && !seen.has(url)) { seen.add(url); found.push({ name, url }); }
  }
  return found;
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

async function downloadAudio(url: string, dest: string): Promise<void> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

/** Fetch top sounds, screen them, and add approved ones to the pool. */
/** Page through the myinstants category until `maxFresh` not-yet-stored sounds are found. */
async function fetchSoundPages(have: Set<string>, maxFresh: number): Promise<Scraped[]> {
  const fresh: Scraped[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= 15 && fresh.length < maxFresh; page++) {
    const url = page === 1 ? SOURCE_PAGE : `${SOURCE_PAGE}?page=${page}`;
    let html = "";
    try { const r = await fetch(url, { headers: MI_UA }); if (!r.ok) break; html = await r.text(); }
    catch { break; }
    const items = parsePage(html);
    if (!items.length) break; // no more pages
    for (const i of items) {
      if (seen.has(i.url)) continue;
      seen.add(i.url);
      if (!have.has(i.url)) fresh.push(i);
    }
  }
  return fresh.slice(0, maxFresh);
}

export async function harvestSounds(max = 24): Promise<{ added: number; rejected: number; total: number }> {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const sounds = loadSounds();
  const have = new Set(sounds.map((s) => s.source_url));
  const fresh = await fetchSoundPages(have, max);
  if (!fresh.length) return { added: 0, rejected: 0, total: listSounds().length };

  const verdicts = await screen(fresh.map((s) => s.name));

  let added = 0, rejected = 0;
  for (const s of fresh) {
    const v = verdicts.get(s.name) ?? keywordVerdict(s.name);
    let id = slugify(s.name) || "sound";
    while (sounds.some((x) => x.id === id)) id += "-x";
    const base: Sound = {
      id, kind: "sound", name: s.name, source_url: s.url, file: `/data/sounds/audio/${id}.mp3`,
      tags: v.tags ?? [], flags: v.loud ? ["loud"] : [],
      safety: v.safe ? "approved" : "rejected", reject_reason: v.safe ? undefined : (v.reason || "unsafe"),
      plays: 0, reward_sum: 0, score: 0, best: 0, created_at: new Date().toISOString(),
    };
    if (!v.safe) { sounds.push(base); rejected++; continue; }
    try {
      await downloadAudio(s.url, path.join(AUDIO_DIR, `${id}.mp3`));
      sounds.push(base); added++;
    } catch (e) {
      console.error(`[live] skip ${s.name}:`, (e as Error).message);
    }
  }
  saveSounds(sounds);
  return { added, rejected, total: listSounds().length };
}

/* --------------------------------------------------------- video harvest (V2) */

// Meme-short searches — punchy internet humor, not wholesome filler. A wide,
// niche-diverse set so results don't all collapse to the same viral clips. The
// safety gate screens every result, so edgier queries are fine.
const VIDEO_QUERIES = [
  "dank meme shorts", "brainrot meme shorts", "cat meme shorts funny",
  "tiktok funny meme shorts", "funny shitpost shorts", "gen z humor shorts",
  "relatable meme shorts", "funny memes shorts 2025", "skibidi meme shorts",
  "ohio meme shorts", "funny gaming meme shorts", "anime meme shorts",
  "funny dog meme shorts", "reddit meme shorts", "absurd meme shorts",
  "surreal meme shorts", "deep fried meme shorts", "npc meme shorts",
  "funny reaction meme shorts", "rage comic shorts", "funny fail shorts",
  "meme song shorts", "discord meme shorts", "wholesome meme shorts",
  "funny moments meme shorts", "edgy meme shorts",
];

interface YtEntry { id: string; title: string; duration: number }

function cleanTitle(t: string): string {
  const s = decodeEntities(t).trim();
  return s.length > 70 ? s.slice(0, 67) + "…" : s;
}

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** yt-dlp metadata-only search (no download). */
async function ytSearch(query: string, n: number): Promise<YtEntry[]> {
  const { stdout } = await execFileP(
    "yt-dlp", ["-J", "--flat-playlist", "--no-warnings", `ytsearch${n}:${query}`],
    { maxBuffer: 16 * 1024 * 1024 });
  const data = JSON.parse(stdout) as { entries?: { id: string; title?: string; duration?: number }[] };
  return (data.entries ?? []).filter((e) => e?.id).map((e) => ({ id: e.id, title: e.title ?? "", duration: Number(e.duration ?? 0) }));
}

/** Download the first 12s of a YouTube video as an mp4 (video+audio). Returns path or null. */
async function ytDownload(videoId: string, id: string): Promise<string | null> {
  const out = path.join(VIDEO_DIR, `${id}.mp4`);
  try {
    await execFileP("yt-dlp", [
      "-f", "b[height<=480][ext=mp4]/bv*[height<=480]+ba/b",
      "--download-sections", "*0-12", "--merge-output-format", "mp4",
      "--no-playlist", "--no-warnings", "-o", path.join(VIDEO_DIR, `${id}.%(ext)s`),
      `https://www.youtube.com/watch?v=${videoId}`,
    ], { maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    console.error(`[live] yt-dlp ${videoId}:`, (e as Error).message.split("\n")[0]);
  }
  return fs.existsSync(out) ? out : null;
}

/** True if the file has an audio stream that isn't effectively silent. */
async function hasUsableAudio(file: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP("ffprobe", ["-v", "error", "-select_streams", "a",
      "-show_entries", "stream=codec_type", "-of", "csv=p=0", file]);
    if (!stdout.trim()) return false;
  } catch { return false; }
  try {
    const { stderr } = await execFileP("ffmpeg", ["-hide_banner", "-i", file, "-af", "volumedetect", "-f", "null", "-"]);
    const m = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/);
    return m ? parseFloat(m[1]) > -50 : true; // present but unmeasured → assume ok
  } catch { return true; }
}

/** Replace a clip's audio with a sound looped to fill the whole video. */
async function fillWithSound(videoPath: string, soundPath: string): Promise<void> {
  const tmp = `${videoPath}.fill.mp4`;
  await execFileP("ffmpeg", ["-y", "-i", videoPath, "-stream_loop", "-1", "-i", soundPath,
    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-shortest", tmp]);
  fs.renameSync(tmp, videoPath);
}

/** Claude vision screens a sampled frame for safety + humor tags. */
async function screenFrame(jpgPath: string, title: string): Promise<Verdict> {
  if (!process.env.ANTHROPIC_API_KEY) return { name: title, safe: !BLOCK.test(title), tags: [], loud: false };
  try {
    const data = fs.readFileSync(jpgPath).toString("base64");
    const res = await client.messages.create({
      model: SCREEN_MODEL, max_tokens: 500,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data } },
        { type: "text", text:
          `This is a frame from a short funny video titled "${title}". Screen it for a humor app. ` +
          "Mark safe=false for violence/gore/injury, sexual/graphic, hate, self-harm, or distressing content. " +
          "Set loud=true if it looks like a startling/loud clip. Add 1-3 humor tags from " +
          "[slapstick, meme, animal, gross, wholesome, absurd, fail, classic]. " +
          'Return ONLY JSON: {"safe":true,"reason":"","tags":["animal"],"loud":false}.' },
      ] }],
    });
    const v = jsonFrom<Verdict>(res);
    return { name: title, safe: !!v.safe, reason: v.reason, tags: v.tags ?? [], loud: !!v.loud };
  } catch (e) {
    console.error("[live] frame screen failed:", (e as Error).message);
    return { name: title, safe: !BLOCK.test(title), tags: [], loud: false };
  }
}

/** Search funny short clips with yt-dlp, download 12s (video+audio), screen each, add safe ones. */
export async function harvestVideos(max = 8): Promise<{ added: number; rejected: number; total: number }> {
  fs.mkdirSync(VIDEO_DIR, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memelab-vid-"));
  try {
    const sounds = loadSounds();
    const have = new Set(sounds.map((s) => s.source_url));

    // gather candidates across several meme-short searches — breadth scales with the ask
    const candidates: { videoId: string; title: string; url: string; dur: number }[] = [];
    const seen = new Set<string>();
    const queryCount = Math.min(VIDEO_QUERIES.length, Math.ceil(max / 6) + 3);
    for (const q of shuffle([...VIDEO_QUERIES]).slice(0, queryCount)) {
      let ents: YtEntry[] = [];
      try { ents = await ytSearch(q, 25); } catch (e) { console.error("[live] search failed:", (e as Error).message); }
      for (const e of ents) {
        const url = `https://www.youtube.com/watch?v=${e.id}`;
        if (seen.has(e.id) || have.has(url)) continue;
        if (e.duration && e.duration > 120) continue; // skip long compilations — want self-contained shorts
        seen.add(e.id);
        candidates.push({ videoId: e.id, title: e.title, url, dur: e.duration });
      }
    }
    if (!candidates.length) throw new Error("no candidate videos found (yt-dlp search returned nothing)");
    // prefer genuine shorts (shortest known duration first; unknowns last)
    candidates.sort((a, b) => (a.dur || 999) - (b.dur || 999));

    const existing = new Set(sounds.map((s) => s.id));
    const soundFiles = sounds.filter((s) => s.kind === "sound").map((s) => localOf(s.file)).filter((p) => fs.existsSync(p));
    // Process more than `max` (some downloads fail / get rejected), in parallel.
    const slice = candidates.filter((c) => !existing.has(`yt-${c.videoId}`)).slice(0, Math.ceil(max * 1.4));
    type Res = { clip?: Sound; rejected?: boolean } | null;
    const results = await mapPool<typeof slice[number], Res>(slice, VIDEO_CONCURRENCY, async (c) => {
      const id = `yt-${c.videoId}`;
      const outPath = path.join(VIDEO_DIR, `${id}.mp4`);
      const framePath = path.join(tmp, `${id}.jpg`);
      const file = await ytDownload(c.videoId, id);
      if (!file) return null;
      try {
        await execFileP("ffmpeg", ["-y", "-ss", "0.5", "-i", outPath, "-frames:v", "1", "-vf", "scale=400:-1", framePath]);
        const verdict = await screenFrame(framePath, c.title);
        if (!verdict.safe) { fs.rmSync(outPath, { force: true }); return { rejected: true }; }
        // guarantee audible sound: fill silent/quiet clips with a looped pool sound
        const flags = verdict.loud ? ["loud"] : [];
        if (soundFiles.length && !(await hasUsableAudio(outPath))) {
          await fillWithSound(outPath, soundFiles[Math.floor(Math.random() * soundFiles.length)]);
          flags.push("filled-audio");
        }
        return { clip: {
          id, kind: "video", name: cleanTitle(c.title), source_url: c.url,
          file: `/data/sounds/video/${id}.mp4`, duration: 12,
          tags: verdict.tags ?? [], flags,
          safety: "approved", plays: 0, reward_sum: 0, score: 0, best: 0, created_at: new Date().toISOString(),
        } };
      } catch (e) {
        console.error(`[live] video skip ${c.videoId}:`, (e as Error).message);
        fs.rmSync(outPath, { force: true });
        return null;
      }
    });

    const all = loadSounds();
    let added = 0, rejected = 0;
    for (const r of results) {
      if (!r) continue;
      if (r.rejected) { rejected++; continue; }
      if (!r.clip) continue;
      if (added >= max) { fs.rmSync(localOf(r.clip.file), { force: true }); continue; } // trim overflow
      all.push(r.clip); added++;
    }
    saveSounds(all);
    return { added, rejected, total: listSounds().length };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* ----------------------------------------------------------- remix (V3) */

interface RemixSpec { video: string; sound: string; top: string; bottom: string }

const localOf = (f: string) => path.join(DATA, f.replace(/^\/data\//, ""));
const byScore = (a: Sound, b: Sound) => b.score - a.score || b.best - a.best;

/** Claude pairs videos with sounds and writes meme captions; random fallback offline. */
async function pairRemixes(videos: Sound[], sounds: Sound[], count: number): Promise<RemixSpec[]> {
  const fallback = (): RemixSpec[] => Array.from({ length: count }, (_, i) => ({
    video: videos[i % videos.length].id,
    sound: sounds[(i * 3 + 1) % sounds.length].id,
    top: "", bottom: "",
  }));
  if (!process.env.ANTHROPIC_API_KEY) return fallback();
  try {
    const vList = videos.map((v) => `${v.id}: "${v.name}" [${v.tags.join(", ")}]`).join("\n");
    const sList = sounds.map((s) => `${s.id}: "${s.name}" [${s.tags.join(", ")}]`).join("\n");
    const res = await client.messages.create({
      model: MODEL, max_tokens: 1500,
      messages: [{ role: "user", content:
        "You are a meme remixer. Pair a VIDEO with a SOUND that would be funny played over it, and write " +
        `a short top/bottom meme caption (UPPERCASE, punchy, <=6 words each; either may be ""). ` +
        `Make ${count} distinct, varied remixes.\n\nVIDEOS:\n${vList}\n\nSOUNDS:\n${sList}\n\n` +
        'Return ONLY JSON: [{"video":"<id>","sound":"<id>","top":"...","bottom":"..."}, ...].' }],
    });
    const specs = jsonFrom<RemixSpec[]>(res);
    const ok = specs.filter((s) => s && s.video && s.sound).slice(0, count);
    return ok.length ? ok : fallback();
  } catch (e) {
    console.error("[live] remix pairing failed:", (e as Error).message);
    return fallback();
  }
}

/** Fuse video visuals with sounds into new captioned remix clips.
 *  exploit (default): top-scoring videos. explore: unplayed/least-played videos,
 *  shuffled — so a no-laugh streak pulls in fresh material the user hasn't seen. */
export async function remixClips(count = 4, explore = false): Promise<{ added: number; total: number }> {
  fs.mkdirSync(VIDEO_DIR, { recursive: true });
  const clips = listSounds();
  const videos = clips.filter((c) => c.kind === "video");
  const sounds = clips.filter((c) => c.kind === "sound");
  if (!videos.length || !sounds.length) throw new Error("need at least one video and one sound to remix");

  // shuffle THEN sort so equal/zero scores break ties randomly (avoids regenerating
  // the same mixes when there's little/no ranking signal yet).
  const unplayed = shuffle(videos.filter((v) => v.plays === 0));
  const topV = explore
    ? (unplayed.length >= 4 ? unplayed : shuffle([...videos]).sort((a, b) => a.plays - b.plays)).slice(0, 8)
    : shuffle([...videos]).sort(byScore).slice(0, 8);
  const topS = shuffle([...sounds]).sort(byScore).slice(0, 8);
  const specs = await pairRemixes(topV, topS, count);

  const all = loadSounds();
  let added = 0;
  for (const spec of specs) {
    const v = topV.find((x) => x.id === spec.video) ?? topV[0];
    const s = topS.find((x) => x.id === spec.sound) ?? topS[0];
    let id = `rmx-${v.id.replace(/^yt-/, "")}-${s.id}`.slice(0, 56);
    while (all.some((x) => x.id === id)) id += "x";
    const outPath = path.join(VIDEO_DIR, `${id}.mp4`);
    try {
      // video visuals (copy) + the chosen sound LOOPED to fill the whole clip
      // (so a 1s sound doesn't leave 11s of silence), trimmed to the video length.
      await execFileP("ffmpeg", ["-y", "-i", localOf(v.file), "-stream_loop", "-1", "-i", localOf(s.file),
        "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-shortest", outPath]);
      const clip: Sound = {
        id, kind: "remix", name: `${s.name} × ${v.name}`.slice(0, 70),
        source_url: `remix://${v.id}+${s.id}`, file: `/data/sounds/video/${id}.mp4`,
        duration: v.duration ?? 12, caption: { top: spec.top ?? "", bottom: spec.bottom ?? "" },
        parents: { video: v.id, sound: s.id },
        tags: Array.from(new Set([...(v.tags ?? []), ...(s.tags ?? []), "remix"])).slice(0, 5),
        flags: [], safety: "approved",
        plays: 0, reward_sum: 0, score: 0, best: 0, created_at: new Date().toISOString(),
      };
      all.push(clip); added++;
    } catch (e) {
      console.error(`[live] remix failed ${v.id}×${s.id}:`, (e as Error).message);
      fs.rmSync(outPath, { force: true });
    }
  }
  saveSounds(all);
  return { added, total: listSounds().length };
}

/** Backfill: fill any existing silent/quiet video clips with a looped pool sound. */
export async function fillSilentClips(): Promise<{ filled: number; checked: number }> {
  const all = loadSounds();
  const soundFiles = all.filter((s) => s.kind === "sound").map((s) => localOf(s.file)).filter((p) => fs.existsSync(p));
  if (!soundFiles.length) return { filled: 0, checked: 0 };
  let filled = 0, checked = 0;
  const videos = all.filter((s) => s.kind === "video");
  await mapPool(videos, VIDEO_CONCURRENCY, async (clip) => {
    const p = localOf(clip.file);
    if (!fs.existsSync(p)) return;
    checked++;
    if (!(await hasUsableAudio(p))) {
      await fillWithSound(p, soundFiles[Math.floor(Math.random() * soundFiles.length)]);
      if (!clip.flags.includes("filled-audio")) clip.flags.push("filled-audio");
      filled++;
    }
  });
  saveSounds(all);
  return { filled, checked };
}

/* ----------------------------------------------------- recommender (bandit) */

// Gaussian-ish Thompson sampling over the approved pool, nudged by the user's
// learned tag affinity, with a recency exclude so the feed never repeats.
export function pickNext(excludeIds: string[] = [], kinds?: string[]): Sound | null {
  const base = kinds?.length ? listSounds().filter((s) => kinds.includes(s.kind)) : listSounds();
  const pool = base.filter((s) => !excludeIds.includes(s.id));
  const candidates = pool.length ? pool : base;
  if (!candidates.length) return null;

  const profile = loadProfile();
  const affinity = (s: Sound) => {
    let a = 0, n = 0;
    for (const t of s.tags) {
      const e = profile.tag_affinity[t];
      if (e && e.n) { a += e.sum / e.n; n++; }
    }
    return n ? a / n : 0.5; // neutral prior
  };

  let best: Sound | null = null, bestDraw = -Infinity;
  for (const s of candidates) {
    const mean = s.plays > 0 ? s.score : affinity(s);       // cold-start from tag affinity
    const sd = 1 / Math.sqrt(s.plays + 1);                  // explore the unplayed
    const draw = mean + sd * gauss() + 0.15 * (affinity(s) - 0.5);
    if (draw > bestDraw) { bestDraw = draw; best = s; }
  }
  return best;
}

// Box–Muller standard normal.
function gauss(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* -------------------------------------------------------------- scoring */

function applyReward(clip: Sound, r: number): void {
  clip.plays += 1;
  clip.reward_sum += r;
  clip.score = clip.reward_sum / clip.plays;
  clip.best = Math.max(clip.best, r);
}

export function scoreSound(id: string, reward: number): Sound | null {
  const r = Math.max(0, Math.min(1, reward));
  const sounds = loadSounds();
  const s = sounds.find((x) => x.id === id);
  if (!s) return null;
  applyReward(s, r);

  // Credit assignment: a remix's reward also flows to its base video AND sound.
  // Averaged over many different pairings, each base asset's score converges to its
  // own contribution — so we learn whether the video or the sound is the funny part.
  if (s.kind === "remix" && s.parents) {
    const v = sounds.find((x) => x.id === s.parents!.video);
    const snd = sounds.find((x) => x.id === s.parents!.sound);
    if (v) applyReward(v, r);
    if (snd) applyReward(snd, r);
  }
  saveSounds(sounds);

  const profile = loadProfile();
  profile.total_plays += 1;
  for (const t of s.tags) {
    const e = profile.tag_affinity[t] ?? { sum: 0, n: 0 };
    e.sum += r; e.n += 1;
    profile.tag_affinity[t] = e;
  }
  profile.updated_at = new Date().toISOString();
  saveJSON(PROFILE, profile);
  return s;
}

export function humorProfile(): HumorProfile { return loadProfile(); }

/** Delete all remix clips (files + index entries); base sounds/videos are kept. */
export function clearRemixes(): { deleted: number } {
  const all = loadSounds();
  const remixes = all.filter((s) => s.kind === "remix");
  for (const s of remixes) { try { fs.rmSync(localOf(s.file), { force: true }); } catch { /* already gone */ } }
  saveSounds(all.filter((s) => s.kind !== "remix"));
  return { deleted: remixes.length };
}

/** Wipe all learned ranking signal: zero every clip's score/plays and clear the profile. */
export function resetScores(): { reset: number } {
  const sounds = loadSounds();
  for (const s of sounds) { s.plays = 0; s.reward_sum = 0; s.score = 0; s.best = 0; }
  saveSounds(sounds);
  saveJSON(PROFILE, { tag_affinity: {}, total_plays: 0, updated_at: "" });
  return { reset: sounds.length };
}
