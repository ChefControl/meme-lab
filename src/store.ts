import fs from "node:fs";
import path from "node:path";

export const DATA = path.resolve(process.env.MEME_LAB_DATA ?? "data");
export const RAW = path.join(DATA, "raw");
export const TPL = path.join(DATA, "templates");

export const MIN_EXAMPLES = 10; // examples needed before a template can be analyzed

for (const d of [DATA, RAW, TPL]) fs.mkdirSync(d, { recursive: true });

export function loadJSON<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

export function saveJSON(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf-8");
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------- types

export interface ImgflipTemplate {
  id: string;
  name: string;
  url: string;
  width: number;
  height: number;
  box_count: number;
}

export interface Example {
  id: string;
  image: string; // relative path under data/
  texts: string[];
  joke: string;
  post: { title: string; score: number; subreddit: string; permalink: string };
  added_at: string;
}

/** Where one text box sits on the template image (percent coordinates). */
export interface TemplateBox {
  role: string;   // what this box represents in the format
  x_pct: number;  // top-left of the text area, % of image width
  y_pct: number;  // top-left of the text area, % of image height
  w_pct: number;  // text area width, % of image width
  h_pct: number;  // text area height, % of image height
}

export interface Analysis {
  /** The single idea this template exists to express — every caption must land it. */
  core_idea?: string;
  context: string;
  structure: string;
  tone: string;
  rules: string[];
  analyzed_at: string;
  example_count: number;
  /** Set by refineAnalysis when "wrong format" flags trigger a revision. */
  corrections?: string[];
  revision?: number;
  format_feedback_count?: number;
  /** Vision-derived caption locations, in caption order. */
  box_layout?: TemplateBox[];
}

export interface Candidate {
  id: string;
  top: string;
  bottom: string;
  // funny/meh judge the CAPTION (humor learnings).
  // bad_context: caption misses the template's core idea (revises the analysis).
  // bad_structure: caption too long / mispositioned / wrong label mapping.
  // bad_format: legacy combined flag (treated as structural).
  status: "pending" | "funny" | "meh" | "bad_context" | "bad_structure" | "bad_format";
  batch: number;
  created_at: string;
  rated_at?: string;
  reason?: string; // user's "this is funny/meh because..." — feeds the learning loop
  elo?: number;    // 1v1 duel rating (funny memes only)
  duels?: number;  // number of duels fought
}

export interface Learnings {
  positive_prompt: string;
  negative_prompt: string;
  funny_count: number;
  meh_count: number;
  built_at: string;
}

// ---------------------------------------------------------------- template store

const tplFile = (slug: string, name: string) => path.join(TPL, slug, name);

export function ensureTemplate(imgflip: ImgflipTemplate): string {
  const slug = slugify(imgflip.name);
  const metaPath = tplFile(slug, "meta.json");
  if (!fs.existsSync(metaPath)) {
    saveJSON(metaPath, { slug, name: imgflip.name, imgflip, created_at: new Date().toISOString() });
    fs.mkdirSync(path.join(TPL, slug, "funny"), { recursive: true });
    fs.mkdirSync(path.join(TPL, slug, "meh"), { recursive: true });
  }
  return slug;
}

export function addExample(slug: string, example: Example): void {
  const file = tplFile(slug, "examples.json");
  const examples = loadJSON<Example[]>(file, []);
  if (!examples.some((e) => e.id === example.id)) {
    examples.push(example);
    saveJSON(file, examples);
  }
}

export function getTemplate(slug: string) {
  return {
    meta: loadJSON<{ slug: string; name: string; imgflip: ImgflipTemplate } | null>(tplFile(slug, "meta.json"), null),
    examples: loadJSON<Example[]>(tplFile(slug, "examples.json"), []),
    analysis: loadJSON<Analysis | null>(tplFile(slug, "analysis.json"), null),
    candidates: loadJSON<Candidate[]>(tplFile(slug, "candidates.json"), []),
    learnings: loadJSON<Learnings | null>(tplFile(slug, "learnings.json"), null),
  };
}

export function saveCandidates(slug: string, candidates: Candidate[]): void {
  saveJSON(tplFile(slug, "candidates.json"), candidates);
}

export function listTemplates() {
  if (!fs.existsSync(TPL)) return [];
  return fs.readdirSync(TPL)
    .filter((d) => fs.existsSync(path.join(TPL, d, "meta.json")))
    .map((slug) => {
      const t = getTemplate(slug);
      const funny = t.candidates.filter((c) => c.status === "funny").length;
      const meh = t.candidates.filter((c) => c.status === "meh").length;
      const badContext = t.candidates.filter((c) => c.status === "bad_context").length;
      const badStructure = t.candidates.filter(
        (c) => c.status === "bad_structure" || c.status === "bad_format").length; // legacy → structural
      const pending = t.candidates.filter((c) => c.status === "pending");
      return {
        slug,
        name: t.meta!.name,
        blank_url: t.meta!.imgflip.url,
        box_count: t.meta!.imgflip.box_count,
        examples: t.examples.length,
        min_examples: MIN_EXAMPLES,
        analyzed: !!t.analysis,
        revision: t.analysis?.revision ?? (t.analysis ? 1 : 0),
        box_layout: t.analysis?.box_layout ?? null,
        funny,
        meh,
        bad_context: badContext,
        bad_structure: badStructure,
        pending,
        learnings: t.learnings ? { funny: t.learnings.funny_count, meh: t.learnings.meh_count } : null,
      };
    })
    .sort((a, b) => b.examples - a.examples);
}
