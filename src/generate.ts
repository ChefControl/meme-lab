/**
 * Candidate generation with preference learning.
 *
 * Each round generates 10 captions. Ratings from previous rounds are distilled
 * by Claude into a positive prompt (what made captions funny) and a negative
 * prompt (what made them meh), which steer the next round — a small-scale
 * RLHF-style loop.
 */
import crypto from "node:crypto";
import path from "node:path";

import { ensureBoxLayout, refineAnalysis } from "./analyze.js";
import { client, MODEL, jsonFrom } from "./claude.js";
import { TPL, Candidate, Learnings, getTemplate, saveCandidates, saveJSON } from "./store.js";

const ROUND_SIZE = 10;

async function buildLearnings(slug: string): Promise<Learnings | null> {
  const t = getTemplate(slug);
  const funny = t.candidates.filter((c) => c.status === "funny");
  const meh = t.candidates.filter((c) => c.status === "meh");
  if (funny.length + meh.length < 4) return null; // not enough signal yet

  // reuse cached learnings if the rating counts haven't changed
  if (t.learnings && t.learnings.funny_count === funny.length && t.learnings.meh_count === meh.length) {
    return t.learnings;
  }

  const fmt = (c: Candidate) =>
    `"${c.top}" / "${c.bottom}"${c.reason ? ` — user's reason: "${c.reason}"` : ""}`;
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    messages: [{
      role: "user",
      content: `You are analyzing human feedback on AI-generated captions for the meme template "${t.meta!.name}".

Captions the human rated FUNNY (with their stated reasons where given — weigh the reasons heavily, they are the clearest preference signal):
${funny.map(fmt).join("\n") || "(none yet)"}

Captions the human rated MEH (with their stated reasons where given — weigh the reasons heavily):
${meh.map(fmt).join("\n") || "(none yet)"}

Distill the preference signal:
- positive_prompt: 2-4 sentences describing the patterns, topics, structures, and humor styles that the funny captions share — phrased as instructions to FOLLOW when writing new captions.
- negative_prompt: 2-4 sentences describing what the meh captions did wrong (clichés, weak punchlines, topic choices, structures) — phrased as instructions to AVOID.

Return ONLY raw JSON: {"positive_prompt": "...", "negative_prompt": "..."}`,
    }],
  });

  const parsed = jsonFrom<{ positive_prompt: string; negative_prompt: string }>(res);
  const learnings: Learnings = {
    ...parsed,
    funny_count: funny.length,
    meh_count: meh.length,
    built_at: new Date().toISOString(),
  };
  saveJSON(path.join(TPL, slug, "learnings.json"), learnings);
  return learnings;
}

export async function generateCandidates(slug: string, count = ROUND_SIZE): Promise<Candidate[]> {
  let t = getTemplate(slug);
  if (!t.meta) throw new Error(`Unknown template: ${slug}`);
  if (!t.analysis) throw new Error("Template must be analyzed first (needs 10+ examples)");

  // wrong-format flags revise the analysis itself before we generate again
  await refineAnalysis(slug);
  await ensureBoxLayout(slug); // backfill caption locations for older analyses
  t = getTemplate(slug);

  const learnings = await buildLearnings(slug);
  const batch = Math.max(0, ...t.candidates.map((c) => c.batch)) + 1;

  const exampleTexts = t.examples.slice(0, 12)
    .map((e, i) => `${i + 1}. ${JSON.stringify(e.texts)}`).join("\n");
  const alreadyUsed = t.candidates.map((c) => `"${c.top}" / "${c.bottom}"`).join("\n");

  const sections = [
    `You are a meme caption writer. Template: "${t.meta!.name}".${
      t.analysis!.core_idea
        ? `\n\nCORE IDEA — this template exists to express exactly this, and every caption MUST land it (a caption that misses it fails as this meme even if funny):\n${t.analysis!.core_idea}`
        : ""}`,
    `HOW THIS TEMPLATE WORKS (derived from ${t.analysis!.example_count} real top posts${(t.analysis!.revision ?? 1) > 1 ? `, revised ${t.analysis!.revision}x from human format feedback` : ""}):
context: ${t.analysis!.context}
structure: ${t.analysis!.structure}
tone: ${t.analysis!.tone}
rules:\n${t.analysis!.rules.map((r) => `- ${r}`).join("\n")}${
      t.analysis!.corrections?.length
        ? `\n\nFORMAT CORRECTIONS — the human flagged earlier captions as misusing this format; these override anything contradictory above:\n${t.analysis!.corrections.map((c) => `- ${c}`).join("\n")}`
        : ""}`,
    `REAL EXAMPLES from top posts:\n${exampleTexts}`,
  ];
  const layout = t.analysis!.box_layout;
  if (layout?.length) {
    const split = Math.ceil(layout.length / 2);
    sections.push(`TEXT BOXES — this template has ${layout.length} caption boxes, in this order:
${layout.map((b, i) => `${i + 1}. ${b.role}`).join("\n")}
${layout.length <= 2
  ? `Map your caption: "top" = box 1, "bottom" = box 2.`
  : `Write ONE short label per box, in box order. Join boxes 1-${split} with " | " as "top" and boxes ${split + 1}-${layout.length} with " | " as "bottom". Never merge two boxes into one label.`}`);
  }
  if (learnings) {
    sections.push(`POSITIVE PROMPT — the human rated these patterns FUNNY, lean into this:\n${learnings.positive_prompt}`);
    sections.push(`NEGATIVE PROMPT — the human rated these patterns MEH, avoid this:\n${learnings.negative_prompt}`);
  }
  if (alreadyUsed) {
    sections.push(`Do NOT repeat or closely rehash any of these previously generated captions:\n${alreadyUsed}`);
  }
  sections.push(`Write ${count} NEW caption candidates for this template. Vary the topics widely (everyday life, work, relationships, internet culture, food, sleep, money...). Each caption: top text and bottom text fitting the template's structure (if the format only needs one line, leave bottom empty). Keep each line under 70 characters.

Return ONLY a raw JSON array (no markdown fences):
[{"top": "...", "bottom": "..."}]`);

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    messages: [{ role: "user", content: sections.join("\n\n") }],
  });

  const captions = jsonFrom<{ top: string; bottom: string }[]>(res);
  const now = new Date().toISOString();
  const fresh: Candidate[] = captions.slice(0, count).map((c) => ({
    id: crypto.randomUUID().slice(0, 8),
    top: c.top ?? "",
    bottom: c.bottom ?? "",
    status: "pending",
    batch,
    created_at: now,
  }));

  saveCandidates(slug, [...t.candidates, ...fresh]);
  return fresh;
}
