// Canvas meme rendering — ported verbatim from the original app.js. This is the
// imperative escape hatch a component drives via a ref + $effect.
import type { Candidate, QueueItem, TemplateBox } from "./types";

/** Shared renderer: box-aware when the template has a vision-derived layout. */
export function renderCandidate(
  canvas: HTMLCanvasElement,
  item: QueueItem,
  targetW = 700,
  onError?: () => void,
): void {
  const ctx = canvas.getContext("2d")!;
  const img = new Image();
  img.onload = () => {
    const w = Math.max(420, Math.min(img.width, targetW));
    const h = Math.round(img.height * (w / img.width));
    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(img, 0, 0, w, h);

    const labels = splitLabels(item.candidate);
    if (item.box_layout?.length && labels.length === item.box_layout.length) {
      item.box_layout.forEach((box, i) => drawBoxText(ctx, labels[i], box, w, h));
    } else {
      drawStripText(ctx, item.candidate.top, w, h, true);
      drawStripText(ctx, item.candidate.bottom, w, h, false);
    }
  };
  img.onerror = () => onError?.();
  img.src = `/proxy?url=${encodeURIComponent(item.blank_url)}`;
}

/** "A | B" / "C | D" -> ["A","B","C","D"] for multi-box templates. */
function splitLabels(candidate: Candidate): string[] {
  return [...String(candidate.top ?? "").split("|"), ...String(candidate.bottom ?? "").split("|")]
    .map((s) => s.trim())
    .filter(Boolean);
}

function setMemeStyle(ctx: CanvasRenderingContext2D, fontSize: number): void {
  ctx.font = `bold ${fontSize}px Impact, "Arial Black", sans-serif`;
  ctx.textAlign = "center";
  ctx.fillStyle = "white";
  ctx.strokeStyle = "black";
  ctx.lineWidth = Math.max(2, fontSize / 11);
  ctx.lineJoin = "round";
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const probe = line ? line + " " + word : word;
    if (ctx.measureText(probe).width > maxW && line) {
      lines.push(line);
      line = word;
    } else {
      line = probe;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Classic top/bottom strips (fallback when no box layout is known). */
function drawStripText(
  ctx: CanvasRenderingContext2D,
  text: string,
  w: number,
  h: number,
  top: boolean,
): void {
  if (!text) return;
  const fontSize = Math.max(22, Math.floor(w / 13));
  setMemeStyle(ctx, fontSize);
  const lines = wrapText(ctx, text, w * 0.92);
  const lineH = fontSize * 1.15;
  lines.forEach((l, i) => {
    const y = top ? fontSize + 8 + i * lineH : h - 14 - (lines.length - 1 - i) * lineH;
    ctx.strokeText(l, w / 2, y);
    ctx.fillText(l, w / 2, y);
  });
}

/** Draw text inside a vision-located caption box, shrinking the font to fit. */
function drawBoxText(
  ctx: CanvasRenderingContext2D,
  text: string,
  box: TemplateBox,
  w: number,
  h: number,
): void {
  if (!text) return;
  const bx = (box.x_pct / 100) * w;
  const by = (box.y_pct / 100) * h;
  const bw = Math.max(40, (box.w_pct / 100) * w);
  const bh = Math.max(24, (box.h_pct / 100) * h);

  let fontSize = Math.min(Math.floor(bh * 0.55), Math.floor(w / 12));
  let lines: string[] = [];
  for (; fontSize >= 13; fontSize -= 2) {
    setMemeStyle(ctx, fontSize);
    lines = wrapText(ctx, text, bw);
    if (lines.length * fontSize * 1.15 <= bh) break;
  }
  setMemeStyle(ctx, Math.max(13, fontSize));
  const lineH = Math.max(13, fontSize) * 1.15;
  const totalH = lines.length * lineH;
  const startY = by + Math.max(0, (bh - totalH) / 2) + Math.max(13, fontSize); // vertically centered
  lines.forEach((l, i) => {
    ctx.strokeText(l, bx + bw / 2, startY + i * lineH);
    ctx.fillText(l, bx + bw / 2, startY + i * lineH);
  });
}
