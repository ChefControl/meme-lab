import { describe, expect, it } from "vitest";

import { jsonFrom, textOf } from "../src/claude.js";

const msg = (text: string) => ({ content: [{ type: "text", text }] }) as any;

describe("jsonFrom", () => {
  it("parses bare JSON", () => {
    expect(jsonFrom(msg('{"a": 1}'))).toEqual({ a: 1 });
    expect(jsonFrom(msg('[{"a": 1}, {"a": 2}]'))).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("tolerates markdown fences", () => {
    expect(jsonFrom(msg('```json\n{"a": 1}\n```'))).toEqual({ a: 1 });
  });

  it("tolerates surrounding prose", () => {
    expect(jsonFrom(msg('Here you go:\n[{"top": "x", "bottom": "y"}]\nHope that helps!')))
      .toEqual([{ top: "x", bottom: "y" }]);
  });

  it("throws on a response with no text block", () => {
    expect(() => textOf({ content: [] } as any)).toThrow("No text block");
  });
});
