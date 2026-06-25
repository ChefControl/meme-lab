import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

import express from "express";

import { analyzeTemplate, ensureBoxLayout } from "./analyze.js";
import { getDuelPair, leaderboard, recordDuel } from "./duel.js";
import { generateCandidates } from "./generate.js";
import { getImgflipTemplates, harvest, seedTemplate } from "./harvest.js";
import {
  harvestSounds, harvestVideos, remixClips, fillSilentClips, resetScores,
  listSounds, pickNext, scoreSound, leaderboard as soundLeaderboard, humorProfile,
} from "./live.js";
import { DATA, TPL, getTemplate, listTemplates, saveCandidates, saveJSON, loadJSON } from "./store.js";

const app = express();
app.use(express.json({ limit: "15mb" })); // rated meme PNGs arrive as data URLs
app.use(express.static("dist/public")); // Vite build output (client/)
app.use("/data", express.static(DATA));

let busy: string | null = null; // serialize the long-running Claude jobs

function run(label: string, job: () => Promise<unknown>, res: express.Response) {
  if (busy) return res.status(409).json({ error: `Busy: ${busy}` });
  busy = label;
  console.log(`[job] start: ${label}`);
  job()
    .then((result) => {
      console.log(`[job] done: ${label}`);
      res.json(result ?? { ok: true });
    })
    .catch((e) => {
      console.error(`[job] FAILED: ${label}:`, e); // always visible server-side
      res.status(500).json({ error: (e as Error).message });
    })
    .finally(() => { busy = null; });
}

app.get("/api/state", (_req, res) => {
  const raw = loadJSON<unknown[]>(path.join(DATA, "raw", "index.json"), []);
  res.json({ busy, harvested: raw.length, templates: listTemplates() });
});

// Full per-template analysis for the Library detail drawer. Kept off /api/state
// so the list payload stays light — fetched lazily when a drawer opens.
app.get("/api/template/:slug", (req, res) => {
  const t = getTemplate(req.params.slug);
  if (!t.meta) return res.status(404).json({ error: "unknown template" });
  const a = t.analysis;
  res.json({
    slug: t.meta.slug,
    name: t.meta.name,
    analyzed: !!a,
    revision: a?.revision ?? (a ? 1 : 0),
    core_idea: a?.core_idea ?? "",
    context: a?.context ?? "",
    structure: a?.structure ?? "",
    tone: a?.tone ?? "",
    rules: a?.rules ?? [],
    boxes: (a?.box_layout ?? []).map((b) => ({ role: b.role })),
    learning: !!t.learnings,
    positive_prompt: t.learnings?.positive_prompt ?? "",
    negative_prompt: t.learnings?.negative_prompt ?? "",
  });
});

app.post("/api/harvest", (req, res) => {
  const max = Math.min(Number(req.body?.max ?? 30), 60);
  run("harvesting", () => harvest(max), res);
});

app.get("/api/imgflip", async (_req, res) => {
  const templates = await getImgflipTemplates();
  res.json(templates.map((t) => ({ name: t.name, url: t.url, box_count: t.box_count })));
});

app.post("/api/seed", (req, res) => {
  const name = String(req.body?.name ?? "");
  if (!name) return res.status(400).json({ error: "name required" });
  run(`seeding ${name}`, () => seedTemplate(name), res);
});

app.post("/api/analyze/:slug", (req, res) => {
  run(`analyzing ${req.params.slug}`, () => analyzeTemplate(req.params.slug), res);
});

app.post("/api/layout/:slug", (req, res) => {
  run(`locating caption boxes for ${req.params.slug}`, () => ensureBoxLayout(req.params.slug), res);
});

app.post("/api/generate/:slug", (req, res) => {
  const count = req.body?.count ? Math.min(Math.max(1, Number(req.body.count)), 10) : undefined;
  run(`generating for ${req.params.slug}`, () => generateCandidates(req.params.slug, count), res);
});

app.post("/api/rate", (req, res) => {
  const { slug, id, rating, image, reason } = req.body as {
    slug: string; id: string; image?: string; reason?: string;
    rating: "funny" | "meh" | "bad_context" | "bad_structure" | "bad_format";
  };
  if (!["funny", "meh", "bad_context", "bad_structure", "bad_format"].includes(rating)) {
    return res.status(400).json({ error: "rating must be funny|meh|bad_context|bad_structure" });
  }

  const t = getTemplate(slug);
  const candidate = t.candidates.find((c) => c.id === id);
  if (!candidate) return res.status(404).json({ error: "candidate not found" });

  candidate.status = rating;
  candidate.rated_at = new Date().toISOString();
  if (reason?.trim()) candidate.reason = reason.trim().slice(0, 500);
  saveCandidates(slug, t.candidates);

  const RATING_DIRS: Record<string, string> = {
    funny: "funny", meh: "meh",
    bad_context: "context-fail", bad_structure: "structure-fail",
    bad_format: "bad-format", // legacy
  };
  const dir = path.join(TPL, slug, RATING_DIRS[rating]);
  fs.mkdirSync(dir, { recursive: true });
  if (image?.startsWith("data:image/png;base64,")) {
    fs.writeFileSync(path.join(dir, `${id}.png`), Buffer.from(image.split(",")[1], "base64"));
  }
  saveJSON(path.join(dir, `${id}.json`), candidate);

  const remaining = t.candidates.filter((c) => c.status === "pending").length;
  res.json({ ok: true, remaining });
});

app.get("/api/duel", (_req, res) => {
  const pair = getDuelPair();
  if (!pair) return res.json({ pair: null });
  res.json({ pair });
});

app.post("/api/duel", (req, res) => {
  const { winner, loser } = req.body as {
    winner: { slug: string; id: string }; loser: { slug: string; id: string };
  };
  if (!winner?.slug || !winner?.id || !loser?.slug || !loser?.id) {
    return res.status(400).json({ error: "winner and loser {slug,id} required" });
  }
  try {
    res.json(recordDuel(winner, loser));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.get("/api/leaderboard", (_req, res) => {
  res.json(leaderboard(20));
});

/* ---------------------------------------------------------- Meme Lab Live */

app.get("/api/live/sounds", (_req, res) => {
  res.json({ sounds: listSounds(), profile: humorProfile() });
});

app.post("/api/live/harvest", (req, res) => {
  const max = Math.min(Math.max(1, Number(req.body?.max ?? 24)), 200);
  run("harvesting sounds", () => harvestSounds(max), res);
});

app.post("/api/live/harvest-videos", (req, res) => {
  const max = Math.min(Math.max(1, Number(req.body?.max ?? 8)), 150);
  run("harvesting videos", () => harvestVideos(max), res);
});

app.post("/api/live/remix", (req, res) => {
  const count = Math.min(Math.max(1, Number(req.body?.count ?? 4)), 12);
  const explore = !!req.body?.explore;
  run("remixing clips", () => remixClips(count, explore), res);
});

app.post("/api/live/fill-audio", (_req, res) => {
  run("filling silent videos", () => fillSilentClips(), res);
});

// Stateless next-pick: the client passes recently played ids to avoid repeats.
app.post("/api/live/next", (req, res) => {
  const exclude = Array.isArray(req.body?.exclude) ? req.body.exclude.map(String) : [];
  const kinds = Array.isArray(req.body?.kinds) ? req.body.kinds.map(String) : undefined;
  const next = pickNext(exclude, kinds);
  if (!next) return res.json({ sound: null });
  res.json({ sound: next });
});

app.post("/api/live/score", (req, res) => {
  const { id, reward } = req.body as { id?: string; reward?: number };
  if (!id || typeof reward !== "number") return res.status(400).json({ error: "id and reward required" });
  const sound = scoreSound(id, reward);
  if (!sound) return res.status(404).json({ error: "unknown sound" });
  res.json({ sound });
});

app.get("/api/live/leaderboard", (_req, res) => {
  res.json(soundLeaderboard(20));
});

app.post("/api/live/reset-scores", (_req, res) => {
  res.json(resetScores());
});

// Image proxy so the browser canvas isn't CORS-tainted when rendering templates
app.get("/proxy", async (req, res) => {
  const url = String(req.query.url ?? "");
  if (!/^https:\/\/(i\.)?imgflip\.com\//.test(url) && !/^https:\/\/i\.redd\.it\//.test(url)) {
    return res.status(400).send("host not allowed");
  }
  try {
    const upstream = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!upstream.ok) return res.status(upstream.status).send("upstream error");
    res.set("Content-Type", upstream.headers.get("content-type") ?? "image/jpeg");
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    res.status(502).send("fetch failed");
  }
});

const PORT = 5050;
app.listen(PORT, () => console.log(`Meme Lab running on http://localhost:${PORT}`));
