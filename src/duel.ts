/**
 * 1v1 duels: funny-rated memes face off ("this or this — which is funnier?").
 * Winners gain Elo, losers lose it, and the leaderboard ranks the funniest
 * memes across all templates.
 */
import fs from "node:fs";
import path from "node:path";

import { TPL, Candidate, getTemplate, listTemplates, saveCandidates } from "./store.js";

export const BASE_ELO = 1000;
const K = 32;

/** Standard Elo update. Returns [newWinnerElo, newLoserElo]. */
export function eloUpdate(winnerElo: number, loserElo: number, k = K): [number, number] {
  const expectedWin = 1 / (1 + 10 ** ((loserElo - winnerElo) / 400));
  const delta = k * (1 - expectedWin);
  return [Math.round(winnerElo + delta), Math.round(loserElo - delta)];
}

export interface Fighter {
  slug: string;
  template: string;
  id: string;
  top: string;
  bottom: string;
  elo: number;
  duels: number;
  image: string; // URL path the browser can load
}

/** All funny-rated candidates that have a saved rendered image. */
export function listFighters(): Fighter[] {
  const fighters: Fighter[] = [];
  for (const t of listTemplates()) {
    const full = getTemplate(t.slug);
    for (const c of full.candidates) {
      if (c.status !== "funny") continue;
      const png = path.join(TPL, t.slug, "funny", `${c.id}.png`);
      if (!fs.existsSync(png)) continue;
      fighters.push({
        slug: t.slug, template: t.name, id: c.id, top: c.top, bottom: c.bottom,
        elo: c.elo ?? BASE_ELO, duels: c.duels ?? 0,
        image: `/data/templates/${t.slug}/funny/${c.id}.png`,
      });
    }
  }
  return fighters;
}

/** Pick a matchup — adjacent in Elo so fights stay competitive, fewest-duels first. */
export function getDuelPair(): [Fighter, Fighter] | null {
  const fighters = listFighters();
  if (fighters.length < 2) return null;
  fighters.sort((a, b) => a.elo - b.elo);
  // bias toward fighters with few duels so newcomers get ranked quickly
  const minDuels = Math.min(...fighters.map((f) => f.duels));
  const fresh = fighters.filter((f) => f.duels === minDuels);
  const a = fresh[Math.floor(Math.random() * fresh.length)];
  const idx = fighters.findIndex((f) => f.id === a.id && f.slug === a.slug);
  const neighbors = [fighters[idx - 1], fighters[idx + 1]].filter(Boolean) as Fighter[];
  const b = neighbors[Math.floor(Math.random() * neighbors.length)];
  return Math.random() < 0.5 ? [a, b] : [b, a];
}

function applyResult(slug: string, id: string, newElo: number): void {
  const t = getTemplate(slug);
  const c = t.candidates.find((x) => x.id === id);
  if (!c) throw new Error(`candidate ${slug}/${id} not found`);
  c.elo = newElo;
  c.duels = (c.duels ?? 0) + 1;
  saveCandidates(slug, t.candidates);
}

export function recordDuel(
  winner: { slug: string; id: string },
  loser: { slug: string; id: string },
): { winnerElo: number; loserElo: number } {
  const find = (ref: { slug: string; id: string }): Candidate => {
    const c = getTemplate(ref.slug).candidates.find((x) => x.id === ref.id);
    if (!c || c.status !== "funny") throw new Error(`not a funny candidate: ${ref.slug}/${ref.id}`);
    return c;
  };
  const w = find(winner);
  const l = find(loser);
  const [winnerElo, loserElo] = eloUpdate(w.elo ?? BASE_ELO, l.elo ?? BASE_ELO);
  applyResult(winner.slug, winner.id, winnerElo);
  applyResult(loser.slug, loser.id, loserElo);
  return { winnerElo, loserElo };
}

export function leaderboard(limit = 20): Fighter[] {
  return listFighters()
    .sort((a, b) => b.elo - a.elo || b.duels - a.duels)
    .slice(0, limit);
}
