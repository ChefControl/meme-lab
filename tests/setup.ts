import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate every test run in a throwaway data directory so tests never touch
// the real library. store.ts reads this env var at import time.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "meme-lab-test-"));
process.env.MEME_LAB_DATA = tmp;
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "test-key-not-used";
