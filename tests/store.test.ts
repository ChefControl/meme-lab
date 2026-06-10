import fs from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  DATA, TPL, ImgflipTemplate, Candidate,
  slugify, ensureTemplate, addExample, getTemplate, saveCandidates, listTemplates,
} from "../src/store.js";

const drake: ImgflipTemplate = {
  id: "181913649", name: "Drake Hotline Bling",
  url: "https://i.imgflip.com/30b1gx.jpg", width: 1200, height: 1200, box_count: 2,
};

function example(id: string) {
  return {
    id, image: `raw/${id}.jpg`, texts: ["top", "bottom"], joke: "a joke",
    post: { title: "t", score: 1, subreddit: "memes", permalink: "https://r/x" },
    added_at: new Date().toISOString(),
  };
}

describe("slugify", () => {
  it("normalizes template names", () => {
    expect(slugify("Drake Hotline Bling")).toBe("drake-hotline-bling");
    expect(slugify("Is This A Pigeon?")).toBe("is-this-a-pigeon");
    expect(slugify("  Y'all Got Any More Of That  ")).toBe("y-all-got-any-more-of-that");
  });
});

describe("template store", () => {
  beforeAll(() => {
    expect(DATA).toContain("meme-lab-test-"); // safety: never the real data dir
  });

  it("creates a template with meta and rating folders", () => {
    const slug = ensureTemplate(drake);
    expect(slug).toBe("drake-hotline-bling");
    expect(fs.existsSync(path.join(TPL, slug, "meta.json"))).toBe(true);
    expect(fs.existsSync(path.join(TPL, slug, "funny"))).toBe(true);
    expect(fs.existsSync(path.join(TPL, slug, "meh"))).toBe(true);
  });

  it("adds examples and dedupes by id", () => {
    const slug = ensureTemplate(drake);
    addExample(slug, example("e1"));
    addExample(slug, example("e1")); // duplicate
    addExample(slug, example("e2"));
    expect(getTemplate(slug).examples).toHaveLength(2);
  });

  it("counts ratings per status in listTemplates", () => {
    const slug = ensureTemplate(drake);
    const now = new Date().toISOString();
    const mk = (id: string, status: Candidate["status"]): Candidate =>
      ({ id, top: "a", bottom: "b", status, batch: 1, created_at: now });
    saveCandidates(slug, [
      mk("c1", "funny"), mk("c2", "funny"), mk("c3", "meh"),
      mk("c4", "bad_context"), mk("c5", "bad_structure"),
      mk("c6", "bad_format"), // legacy flag counts as structural
      mk("c7", "pending"),
    ]);
    const t = listTemplates().find((x) => x.slug === slug)!;
    expect(t.funny).toBe(2);
    expect(t.meh).toBe(1);
    expect(t.bad_context).toBe(1);
    expect(t.bad_structure).toBe(2); // bad_structure + legacy bad_format
    expect(t.pending).toHaveLength(1);
    expect(t.analyzed).toBe(false);
  });
});
