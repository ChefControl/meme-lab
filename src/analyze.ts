/**
 * Template context analysis — once a template has MIN_EXAMPLES real examples,
 * Claude derives how the template is correctly used.
 */
import fs from "node:fs";
import path from "node:path";

import { client, MODEL, jsonFrom } from "./claude.js";
import { DATA, TPL, MIN_EXAMPLES, Analysis, TemplateBox, getTemplate, saveJSON } from "./store.js";

const MEDIA: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
};

function imageBlock(buf: Buffer, ext: string) {
  return {
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: (MEDIA[ext] ?? "image/jpeg") as any,
      data: buf.toString("base64"),
    },
  };
}

/**
 * Vision pass: locate each caption box on the template image so the renderer
 * can place text where the format actually puts it. Lazy — derived once, then
 * cached on the analysis. Failures are non-fatal (renderer falls back).
 */
export async function ensureBoxLayout(slug: string): Promise<TemplateBox[] | null> {
  const t = getTemplate(slug);
  if (!t.meta || !t.analysis) return null;
  if (t.analysis.box_layout?.length) return t.analysis.box_layout;

  const { imgflip } = t.meta;
  const content: any[] = [];

  const blankRes = await fetch(imgflip.url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!blankRes.ok) return null;
  const blankExt = imgflip.url.split(".").pop()!.toLowerCase();
  content.push({ type: "text", text: `Blank template "${t.meta.name}" (${imgflip.width}x${imgflip.height}px, ${imgflip.box_count} text boxes):` });
  content.push(imageBlock(Buffer.from(await blankRes.arrayBuffer()), blankExt));

  for (const e of t.examples.slice(0, 2)) {
    const file = path.join(DATA, e.image);
    if (!fs.existsSync(file)) continue;
    content.push({ type: "text", text: `Real captioned example (texts in caption order: ${JSON.stringify(e.texts)}):` });
    content.push(imageBlock(fs.readFileSync(file), e.image.split(".").pop()!.toLowerCase()));
  }

  content.push({
    type: "text",
    text: `Determine WHERE each of the ${imgflip.box_count} caption boxes sits on this template, using the captioned examples to see where text actually goes. Boxes must be in caption order (the order the texts read in the examples).

For each box give:
- role: short description of what this box represents in the format (e.g. "the rejected option", "label on the mother")
- x_pct, y_pct: top-left corner of the text area, as percentages of image width/height
- w_pct, h_pct: width/height of the text area, as percentages

Return ONLY a raw JSON array of exactly ${imgflip.box_count} boxes:
[{"role": "...", "x_pct": 0, "y_pct": 0, "w_pct": 0, "h_pct": 0}]`,
  });

  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      messages: [{ role: "user", content }],
    });
    const layout = jsonFrom<TemplateBox[]>(res);
    if (!Array.isArray(layout) || !layout.length) return null;
    const fresh = getTemplate(slug); // re-read: analysis may have been revised meanwhile
    if (!fresh.analysis) return null;
    fresh.analysis.box_layout = layout;
    saveJSON(path.join(TPL, slug, "analysis.json"), fresh.analysis);
    console.log(`[layout] ${t.meta.name}: ${layout.length} boxes located`);
    return layout;
  } catch (e) {
    console.warn(`[layout] ${slug} failed:`, (e as Error).message);
    return null;
  }
}

export async function analyzeTemplate(slug: string): Promise<Analysis> {
  const t = getTemplate(slug);
  if (!t.meta) throw new Error(`Unknown template: ${slug}`);
  if (t.examples.length < MIN_EXAMPLES) {
    throw new Error(`Need at least ${MIN_EXAMPLES} examples, have ${t.examples.length}`);
  }

  const examples = t.examples.map((e, i) =>
    `${i + 1}. texts: ${JSON.stringify(e.texts)} — joke: ${e.joke} (▲${e.post.score})`).join("\n");

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    messages: [{
      role: "user",
      content: `You are a meme format analyst. The template is "${t.meta.name}" (${t.meta.imgflip.box_count} text boxes).

Here are ${t.examples.length} real, highly-upvoted examples of this template in the wild (transcribed text + the joke):
${examples}

From these examples, derive how this template is CORRECTLY used:
- core_idea: the SINGLE idea this template exists to express, in 1-2 sentences. Every template carries one specific idea (e.g. "where monkey" = monkey-brain impulsiveness: I did X and expect the payoff one second later). A caption that doesn't land this exact idea fails as this meme, even if it's funny. Identify the idea from what ALL the successful examples have in common.
- context: the situations this idea thrives in; when this template is the right format to reach for
- structure: what the top text vs bottom text (or each box) semantically represents in this format
- tone: the voice/energy that works for this template
- rules: 4-8 concrete writing rules for captions that fit this format (drawn from what the successful examples do)

Return ONLY raw JSON (no markdown fences):
{"core_idea": "...", "context": "...", "structure": "...", "tone": "...", "rules": ["..."]}`,
    }],
  });

  const parsed = jsonFrom<Omit<Analysis, "analyzed_at" | "example_count">>(res);
  const analysis: Analysis = {
    ...parsed,
    analyzed_at: new Date().toISOString(),
    example_count: t.examples.length,
    revision: 1,
    format_feedback_count: 0,
  };
  saveJSON(path.join(TPL, slug, "analysis.json"), analysis);
  await ensureBoxLayout(slug); // locate caption positions (non-fatal if it fails)
  return getTemplate(slug).analysis ?? analysis;
}

/**
 * Failure flags mean the ANALYSIS misunderstood the template — not that the
 * caption was unfunny. Two failure classes revise different layers:
 *   bad_context   — the caption missed the template's core idea
 *   bad_structure — caption length / positioning / label mapping was wrong
 * (legacy bad_format flags are treated as structural)
 */
export async function refineAnalysis(slug: string): Promise<Analysis | null> {
  const t = getTemplate(slug);
  if (!t.meta || !t.analysis) return t.analysis;

  const ctxFlags = t.candidates.filter((c) => c.status === "bad_context");
  const structFlags = t.candidates.filter(
    (c) => c.status === "bad_structure" || c.status === "bad_format");
  const total = ctxFlags.length + structFlags.length;
  if (total === 0 || (t.analysis.format_feedback_count ?? 0) >= total) {
    return t.analysis; // nothing new to learn from
  }

  const fmt = (c: { top: string; bottom: string; reason?: string }) =>
    `- "${c.top}" / "${c.bottom}"${c.reason ? ` — user's reason: "${c.reason}"` : ""}`;
  const examples = t.examples.slice(0, 12)
    .map((e, i) => `${i + 1}. ${JSON.stringify(e.texts)}`).join("\n");

  const sections = [
    `You previously derived this analysis of the meme template "${t.meta.name}":
${JSON.stringify({ core_idea: t.analysis.core_idea, context: t.analysis.context, structure: t.analysis.structure, tone: t.analysis.tone, rules: t.analysis.rules }, null, 1)}

Captions were then generated following that analysis, and a human flagged failures in two distinct classes:`,
  ];
  if (ctxFlags.length) {
    sections.push(`CONTEXT/IDEA FAILURES — these captions MISSED THE TEMPLATE'S CORE IDEA (structurally fine, but they don't express the specific idea this template carries):
${ctxFlags.map(fmt).join("\n")}`);
  }
  if (structFlags.length) {
    sections.push(`STRUCTURAL FAILURES — these captions were structurally wrong (too long, mispositioned, wrong number of labels, merged boxes, bad box mapping):
${structFlags.map(fmt).join("\n")}`);
  }
  sections.push(`Real examples of correct usage, for reference:
${examples}

Revise the analysis:
- context/idea failures mean the core_idea (and context) were wrong or too loose — sharpen them so captions can't drift off the template's actual idea
- structural failures mean the structure and rules need harder constraints (label counts, line lengths, box mapping)
- keep whatever the flags don't contradict
- corrections: 2-6 short statements of what was misunderstood and the correct rule, each prefixed [idea] or [structure]

Return ONLY raw JSON:
{"core_idea": "...", "context": "...", "structure": "...", "tone": "...", "rules": ["..."], "corrections": ["..."]}`);

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    messages: [{ role: "user", content: sections.join("\n\n") }],
  });

  const parsed = jsonFrom<Pick<Analysis, "core_idea" | "context" | "structure" | "tone" | "rules" | "corrections">>(res);
  const revised: Analysis = {
    ...t.analysis,
    ...parsed,
    analyzed_at: new Date().toISOString(),
    revision: (t.analysis.revision ?? 1) + 1,
    format_feedback_count: total,
  };
  saveJSON(path.join(TPL, slug, "analysis.json"), revised);
  return revised;
}
