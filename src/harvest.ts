/**
 * Harvest pipeline: download top memes from leading subreddits, then have
 * Claude vision break each into (original template, text in image) and file
 * it into the template library.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { client, MODEL, jsonFrom } from "./claude.js";
import {
  DATA, RAW, ImgflipTemplate, Example,
  loadJSON, saveJSON, ensureTemplate, addExample,
} from "./store.js";

const UA = { "User-Agent": "Mozilla/5.0 (MemeLab template research)" };
const SUBS = ["memes", "dankmemes", "me_irl", "wholesomememes", "funny"];
const IMGFLIP_CACHE = path.join(DATA, "imgflip.json");
const RAW_INDEX = path.join(RAW, "index.json");

interface RawEntry {
  id: string;
  file: string;
  post: { title: string; score: number; subreddit: string; permalink: string };
  template: string | null; // imgflip name, null = not template-based / unknown
  analyzed: boolean;
}

interface RedditPost {
  title: string;
  score: number;
  subreddit: string;
  permalink: string;
  image_url: string;
}

const MEDIA: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
};

export async function getImgflipTemplates(): Promise<ImgflipTemplate[]> {
  const cache = loadJSON<{ at: number; templates: ImgflipTemplate[] } | null>(IMGFLIP_CACHE, null);
  if (cache && Date.now() - cache.at < 24 * 3600 * 1000) return cache.templates;
  const res = await fetch("https://api.imgflip.com/get_memes", { headers: UA });
  const json = (await res.json()) as { data: { memes: ImgflipTemplate[] } };
  saveJSON(IMGFLIP_CACHE, { at: Date.now(), templates: json.data.memes });
  return json.data.memes;
}

async function fetchPosts(): Promise<RedditPost[]> {
  const seen = new Set<string>();
  const posts: RedditPost[] = [];
  for (const sub of SUBS) {
    for (let round = 0; round < 2; round++) {
      try {
        const res = await fetch(`https://meme-api.com/gimme/${sub}/50`, { headers: UA });
        if (!res.ok) continue;
        const json = (await res.json()) as { memes?: any[] };
        for (const m of json.memes ?? []) {
          if (!m.postLink || seen.has(m.postLink)) continue;
          seen.add(m.postLink);
          posts.push({
            title: m.title ?? "", score: m.ups ?? 0, subreddit: m.subreddit ?? sub,
            permalink: m.postLink, image_url: m.url ?? "",
          });
        }
      } catch (e) {
        console.warn(`[harvest] r/${sub} round ${round} failed:`, (e as Error).message);
      }
    }
  }
  return posts.sort((a, b) => b.score - a.score);
}

async function identifyBatch(
  entries: RawEntry[],
  templateNames: string[],
): Promise<{ id: string; template: string | null; texts: string[]; joke: string }[]> {
  const content: any[] = [];
  for (const e of entries) {
    const buf = fs.readFileSync(path.join(DATA, e.file));
    const ext = e.file.split(".").pop()!.toLowerCase();
    content.push({ type: "text", text: `Image id=${e.id} — post: "${e.post.title}" (r/${e.post.subreddit}, ${e.post.score} upvotes)` });
    content.push({
      type: "image",
      source: { type: "base64", media_type: MEDIA[ext] ?? "image/png", data: buf.toString("base64") },
    });
  }
  content.push({
    type: "text",
    text: `You are a meme template librarian. For EACH image above, determine:
- template: the meme template it is based on, as the EXACT name from this list (or null if it is not based on any of these — e.g. an original image, screenshot, or comic):
${JSON.stringify(templateNames)}
- texts: ALL text written inside the image, as an array of segments in reading order (transcribe exactly)
- joke: one sentence — what the joke is

Return ONLY a raw JSON array (no markdown fences), one object per image:
[{"id": "...", "template": "Exact Name or null", "texts": ["..."], "joke": "..."}]`,
  });

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    messages: [{ role: "user", content }],
  });
  return jsonFrom(res);
}

/** Transcribe a batch of images that are all KNOWN instances of one template. */
async function transcribeBatch(
  templateName: string,
  images: { id: string; file: string }[],
): Promise<{ id: string; texts: string[]; joke: string }[]> {
  const content: any[] = [];
  for (const img of images) {
    const buf = fs.readFileSync(path.join(DATA, img.file));
    const ext = img.file.split(".").pop()!.toLowerCase();
    content.push({ type: "text", text: `Image id=${img.id}` });
    content.push({
      type: "image",
      source: { type: "base64", media_type: MEDIA[ext] ?? "image/jpeg", data: buf.toString("base64") },
    });
  }
  content.push({
    type: "text",
    text: `Every image above is an instance of the meme template "${templateName}". For EACH image:
- texts: ALL text written in the image, as an array of segments in reading order (transcribe exactly)
- joke: one sentence — what the joke is

Return ONLY a raw JSON array (no markdown fences): [{"id": "...", "texts": ["..."], "joke": "..."}]`,
  });
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    messages: [{ role: "user", content }],
  });
  return jsonFrom(res);
}

/**
 * Seed a template's example library straight from imgflip's per-template page,
 * where every meme is a guaranteed instance of that template.
 */
export async function seedTemplate(imgflipName: string, want = 12): Promise<{
  template: string; seeded: number; total: number;
}> {
  const imgflip = await getImgflipTemplates();
  const tpl = imgflip.find((t) => t.name.toLowerCase() === imgflipName.toLowerCase());
  if (!tpl) throw new Error(`Not an imgflip template: ${imgflipName}`);
  const slug = ensureTemplate(tpl);

  const { getTemplate } = await import("./store.js");
  const existing = new Set(getTemplate(slug).examples.map((e) => e.id));
  const blankId = tpl.url.match(/i\.imgflip\.com\/([a-z0-9]+)\./i)?.[1];
  const urlSlug = tpl.name.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/\s+/g, "-");

  // collect instance image ids from the template's page(s)
  const found: { id: string; url: string; ext: string }[] = [];
  for (let page = 1; page <= 4 && found.length < want; page++) {
    try {
      // the /meme/<id>/<slug> form resolves for every template; the name-only
      // slug 404s to /memegenerator when casing doesn't match imgflip's canonical
      const res = await fetch(
        `https://imgflip.com/meme/${tpl.id}/${urlSlug}?sort=latest-approved&page=${page}`,
        { headers: UA },
      );
      if (!res.ok) break;
      const html = await res.text();
      for (const m of html.matchAll(/i\.imgflip\.com\/([a-z0-9]+)\.(jpg|png|webp)/gi)) {
        const [, id, ext] = m;
        if (id === blankId || existing.has(`ifl_${id}`) || found.some((f) => f.id === id)) continue;
        found.push({ id, url: `https://i.imgflip.com/${id}.${ext}`, ext: ext.toLowerCase() });
        if (found.length >= want) break;
      }
    } catch { break; }
  }
  console.log(`[seed] ${tpl.name}: ${found.length} instance images found`);

  // download (ensure the raw dir exists — store.ts makes it at boot, but a
  // missing dir here would silently swallow every write and seed nothing)
  fs.mkdirSync(path.join(DATA, "raw"), { recursive: true });
  const downloaded: { id: string; file: string }[] = [];
  for (const f of found) {
    try {
      const res = await fetch(f.url, { headers: UA });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 3_000) continue;
      const file = path.join("raw", `ifl_${f.id}.${f.ext}`);
      fs.writeFileSync(path.join(DATA, file), buf);
      downloaded.push({ id: `ifl_${f.id}`, file });
    } catch { /* skip */ }
  }

  // transcribe in batches of 6 and file as examples
  let seeded = 0;
  for (let i = 0; i < downloaded.length; i += 6) {
    const batch = downloaded.slice(i, i + 6);
    try {
      const results = await transcribeBatch(tpl.name, batch);
      for (const r of results) {
        const entry = batch.find((b) => b.id === r.id);
        if (!entry) continue;
        addExample(slug, {
          id: entry.id, image: entry.file, texts: r.texts ?? [], joke: r.joke ?? "",
          post: { title: "(imgflip community meme)", score: 0, subreddit: "imgflip", permalink: `https://imgflip.com/meme/${urlSlug}` },
          added_at: new Date().toISOString(),
        } as Example);
        seeded++;
      }
    } catch (e) {
      console.warn(`[seed] transcribe batch failed:`, (e as Error).message);
    }
    console.log(`[seed] transcribed ${Math.min(i + 6, downloaded.length)}/${downloaded.length}`);
  }

  return { template: tpl.name, seeded, total: getTemplate(slug).examples.length };
}

export async function harvest(maxNew = 30): Promise<{
  fetched: number; new_images: number; identified: number; templated: number; byTemplate: Record<string, number>;
}> {
  const imgflip = await getImgflipTemplates();
  const nameSet = new Map(imgflip.map((t) => [t.name.toLowerCase(), t]));
  const index = loadJSON<RawEntry[]>(RAW_INDEX, []);
  const known = new Set(index.map((e) => e.id));

  const posts = await fetchPosts();
  console.log(`[harvest] ${posts.length} posts fetched`);

  // download new images (ensure raw dir exists, else every write silently skips)
  fs.mkdirSync(path.join(DATA, "raw"), { recursive: true });
  const fresh: RawEntry[] = [];
  for (const p of posts) {
    if (fresh.length >= maxNew) break;
    const ext = (p.image_url.match(/\.(jpg|jpeg|png|webp)$/i)?.[1] ?? "").toLowerCase();
    if (!ext) continue;
    const id = crypto.createHash("sha1").update(p.permalink).digest("hex").slice(0, 12);
    if (known.has(id)) continue;
    try {
      const res = await fetch(p.image_url, { headers: UA });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 5_000 || buf.length > 8_000_000) continue;
      const file = path.join("raw", `${id}.${ext}`);
      fs.writeFileSync(path.join(DATA, file), buf);
      fresh.push({ id, file, post: { title: p.title, score: p.score, subreddit: p.subreddit, permalink: p.permalink }, template: null, analyzed: false });
      known.add(id);
    } catch { /* skip broken downloads */ }
  }
  console.log(`[harvest] ${fresh.length} new images downloaded`);

  // vision identification in batches of 5
  let identified = 0, templated = 0;
  const byTemplate: Record<string, number> = {};
  for (let i = 0; i < fresh.length; i += 5) {
    const batch = fresh.slice(i, i + 5);
    try {
      const results = await identifyBatch(batch, imgflip.map((t) => t.name));
      for (const r of results) {
        const entry = batch.find((e) => e.id === r.id);
        if (!entry) continue;
        entry.analyzed = true;
        identified++;
        const tpl = r.template ? nameSet.get(r.template.toLowerCase()) : undefined;
        if (tpl) {
          entry.template = tpl.name;
          const slug = ensureTemplate(tpl);
          addExample(slug, {
            id: entry.id, image: entry.file, texts: r.texts ?? [], joke: r.joke ?? "",
            post: entry.post, added_at: new Date().toISOString(),
          } as Example);
          templated++;
          byTemplate[tpl.name] = (byTemplate[tpl.name] ?? 0) + 1;
        }
      }
    } catch (e) {
      console.warn(`[harvest] vision batch failed:`, (e as Error).message);
    }
    console.log(`[harvest] identified ${Math.min(i + 5, fresh.length)}/${fresh.length}`);
  }

  saveJSON(RAW_INDEX, [...index, ...fresh]);
  return { fetched: posts.length, new_images: fresh.length, identified, templated, byTemplate };
}
