# meme-lab

A local tool for teaching Claude to write genuinely funny memes through a human-in-the-loop preference learning loop.

Meme Lab harvests real, highly-upvoted memes from the wild, has Claude vision break them down by template, derives how each template is *correctly* used, generates new captions, and then learns from your funny/meh ratings to get better over time. Funny memes go on to fight 1v1 duels for a spot on an Elo leaderboard.

> **Note:** This is a single-user local tool. It runs an unauthenticated Express server on port 5050 — don't expose it to untrusted networks.

## How it works

The pipeline runs in stages, each driven by Claude (`claude-opus-4-8` vision + text):

1. **Harvest** — Pull top posts from meme subreddits (`memes`, `dankmemes`, `me_irl`, `wholesomememes`, `funny`), download the images, and use Claude vision to identify which imgflip template each one is based on and transcribe its text. Identified memes are filed as **examples** under their template.
2. **Seed** — Jump-start a specific template by scraping guaranteed instances straight from its imgflip page, so you don't have to wait for them to show up in the harvest feed.
3. **Analyze** — Once a template has **10+ examples**, Claude derives how it's correctly used: its *core idea*, the *context* it thrives in, what each text box *means*, the right *tone*, and concrete *writing rules*. A vision pass also locates where each caption box sits on the template image.
4. **Generate** — Claude writes 10 new caption candidates per round, steered by the analysis and the template's caption-box layout.
5. **Rate** — You rate each rendered candidate: **😂 funny**, **😐 meh**, or flag it as a misuse of the format (**🧠 bad context** = missed the template's core idea, **📐 bad structure** = wrong length/positioning/labels).
6. **Learn** — Ratings feed back in two ways:
   - **Preference learning** — funny/meh ratings (and your written reasons) are distilled into a *positive prompt* and *negative prompt* that steer the next generation round, RLHF-style.
   - **Analysis refinement** — format-failure flags revise the template analysis itself: context failures sharpen the core idea, structure failures harden the rules.
7. **Duel** — Funny-rated memes face off head-to-head ("which is funnier?"). Winners gain Elo, losers lose it, and an Elo leaderboard ranks the funniest memes across all templates. Matchups pair Elo-adjacent fighters and favor those with the fewest duels so newcomers get ranked quickly.

The result is a loop that keeps tightening: your taste teaches Claude both what's funny (preference prompts) and what each format actually requires (analysis revisions).

## Setup

Requirements: Node.js 18+ and an Anthropic API key.

```bash
npm install
```

Create a `.env` file in the project root:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Then start the app in dev mode (Express API on 5050 + Vite dev server with hot reload on 5173):

```bash
npm run dev
```

Open **http://localhost:5173** — the Vite dev server proxies `/api`, `/proxy`, and `/data` to the Express backend.

For a production-style run, build the front-end and serve everything from Express on one port:

```bash
npm run build && npm start
```

Then open **http://localhost:5050**.

### Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Run the Express API (`tsx watch src/server.ts`, port 5050) and the Vite dev server (port 5173) together |
| `npm run build` | Build the Svelte front-end (`client/`) to `dist/public` |
| `npm start` | Run just the Express server (`tsx src/server.ts`) on port 5050, serving the built front-end |
| `npm test` | Run the test suite (Vitest) |
| `npm run typecheck` | Type-check the server with `tsc --noEmit` |
| `npm run check` | Type-check the Svelte front-end with `svelte-check` |

## Data

All state lives on disk under `data/` (gitignored) and is created automatically:

- `data/raw/` — downloaded harvest images + `index.json`
- `data/templates/<slug>/` — per-template store:
  - `meta.json` — template identity + imgflip metadata
  - `examples.json` — transcribed real-world examples
  - `analysis.json` — derived usage analysis + caption-box layout
  - `candidates.json` — generated captions and their ratings/Elo
  - `learnings.json` — distilled positive/negative preference prompts
  - `funny/`, `meh/`, `context-fail/`, `structure-fail/` — rated candidates (JSON + rendered PNG)
- `data/imgflip.json` — cached imgflip template list (24h TTL)

The data directory location can be overridden with the `MEME_LAB_DATA` environment variable.

## API

The browser UI talks to a small JSON API. Long-running Claude jobs are serialized (one at a time); a second job returns `409 Busy`.

| Method & path | Purpose |
| --- | --- |
| `GET /api/state` | Current status, harvest count, and template list |
| `POST /api/harvest` | Harvest new memes (`{ max }`, capped at 60) |
| `GET /api/imgflip` | Available imgflip templates (for seeding) |
| `POST /api/seed` | Seed a template's examples (`{ name }`) |
| `POST /api/analyze/:slug` | Derive the template analysis |
| `POST /api/layout/:slug` | Locate caption boxes on the template |
| `POST /api/generate/:slug` | Generate a new round of candidates |
| `POST /api/rate` | Rate a candidate (`{ slug, id, rating, image?, reason? }`) |
| `GET` / `POST /api/duel` | Get a matchup / record a result |
| `GET /api/leaderboard` | Top memes by Elo |
| `GET /proxy?url=` | Image proxy (imgflip/redd.it allowlist) to keep the canvas un-tainted |

## Project layout

```
src/
  server.ts    Express server + JSON API
  harvest.ts   Reddit/imgflip harvesting + vision identification
  analyze.ts   Template analysis, box layout, analysis refinement
  generate.ts  Caption generation + preference learning
  duel.ts      Elo duels and leaderboard
  store.ts     On-disk JSON store + types
  claude.ts    Anthropic client + JSON parsing helpers
client/        Svelte 5 front-end (Vite), canvas meme rendering
  src/
    App.svelte           Root component + view routing
    components/          Library, Rate, Duel, Leaderboard, modals
    lib/store.svelte.ts  Central reactive store (runes)
    lib/meme.ts          Canvas meme renderer
    lib/api.ts, types.ts API client + shared types
tests/         Vitest unit tests
```

## Tech

TypeScript · Express · `@anthropic-ai/sdk` (Claude Opus) · Vitest · Svelte 5 + Vite front-end (canvas-rendered memes).
