import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-opus-4-8";
export const client = new Anthropic();

export function textOf(res: Anthropic.Message): string {
  const block = res.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    throw new Error(
      `No text block in response (stop_reason: ${res.stop_reason}, ` +
      `blocks: ${res.content.map((b) => b.type).join(",") || "none"})`,
    );
  }
  return block.text;
}

/** Tolerates code fences or prose around the JSON payload. */
export function jsonFrom<T>(res: Anthropic.Message): T {
  const text = textOf(res);
  const match = text.match(/[\[{][\s\S]*[\]}]/);
  return JSON.parse(match ? match[0] : text) as T;
}
