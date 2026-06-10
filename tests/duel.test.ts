import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { BASE_ELO, eloUpdate, getDuelPair, leaderboard, listFighters, recordDuel } from "../src/duel.js";
import { TPL, Candidate, ImgflipTemplate, ensureTemplate, saveCandidates } from "../src/store.js";

const pigeon: ImgflipTemplate = {
  id: "100777631", name: "Is This A Pigeon",
  url: "https://i.imgflip.com/1o00in.jpg", width: 1587, height: 1425, box_count: 3,
};

function setupFighters(): string {
  const slug = ensureTemplate(pigeon);
  const now = new Date().toISOString();
  const mk = (id: string, status: Candidate["status"]): Candidate =>
    ({ id, top: `top-${id}`, bottom: `bottom-${id}`, status, batch: 1, created_at: now });
  saveCandidates(slug, [mk("f1", "funny"), mk("f2", "funny"), mk("f3", "funny"), mk("m1", "meh")]);
  // duels require a saved rendered PNG; f3 deliberately has none
  for (const id of ["f1", "f2"]) {
    fs.writeFileSync(path.join(TPL, slug, "funny", `${id}.png`), Buffer.from("png"));
  }
  return slug;
}

describe("eloUpdate", () => {
  it("transfers 16 points between equal opponents at K=32", () => {
    expect(eloUpdate(1000, 1000)).toEqual([1016, 984]);
  });

  it("gives the underdog a bigger reward", () => {
    const [underdogWin] = eloUpdate(900, 1100);
    const [favoriteWin] = eloUpdate(1100, 900);
    expect(underdogWin - 900).toBeGreaterThan(favoriteWin - 1100);
  });

  it("is zero-sum", () => {
    const [w, l] = eloUpdate(1234, 987);
    expect(w + l).toBe(1234 + 987);
  });
});

describe("duels", () => {
  it("only fields funny candidates that have a rendered image", () => {
    const slug = setupFighters();
    const fighters = listFighters().filter((f) => f.slug === slug);
    expect(fighters.map((f) => f.id).sort()).toEqual(["f1", "f2"]); // no f3 (no png), no m1 (meh)
    expect(fighters.every((f) => f.elo === BASE_ELO)).toBe(true);
  });

  it("records a duel result and updates both fighters", () => {
    const slug = setupFighters();
    const r = recordDuel({ slug, id: "f1" }, { slug, id: "f2" });
    expect(r.winnerElo).toBe(1016);
    expect(r.loserElo).toBe(984);
    const board = leaderboard().filter((f) => f.slug === slug);
    expect(board[0].id).toBe("f1");
    expect(board[0].duels).toBe(1);
  });

  it("rejects duels for non-funny candidates", () => {
    const slug = setupFighters();
    expect(() => recordDuel({ slug, id: "m1" }, { slug, id: "f1" })).toThrow("not a funny");
  });

  it("produces a valid pair when at least two fighters exist", () => {
    setupFighters();
    const pair = getDuelPair();
    expect(pair).not.toBeNull();
    expect(pair![0].id).not.toBe(pair![1].id);
  });
});
