import { writeFileSync } from 'node:fs';
import { createMemoryApp } from './memory-app.js';

/**
 * `pnpm dev:memory`: the API on port 4000 with in-memory storage and the stand-in model.
 * For frontend work and demos without MongoDB. Sign-up codes are printed here
 * (and written to CODES_FILE as JSON when set). Everything is lost on restart.
 *
 * Env: PORT (4000), FAKE_PLAN (free|pro), FAKE_CREDITS (100), DEMO_DELAY_MS (30), DEMO_IMAGE_DELAY_MS (1500), CODES_FILE.
 */
const codes: Record<string, string> = {};
const app = await createMemoryApp({
  plan: process.env.FAKE_PLAN === 'pro' ? 'pro' : 'free',
  credits: Number(process.env.FAKE_CREDITS ?? 100),
  demoDelayMs: Number(process.env.DEMO_DELAY_MS ?? 30),
  demoImageDelayMs: Number(process.env.DEMO_IMAGE_DELAY_MS ?? 1500),
  browserStepMs: Number(process.env.BROWSER_STEP_MS ?? 1200),
  onCode: (email, code, kind) => {
    codes[`${email}:${kind}`] = code;
    console.log(`[code] ${kind} for ${email}: ${code}`);
    if (process.env.CODES_FILE) writeFileSync(process.env.CODES_FILE, JSON.stringify(codes));
  },
});
const port = Number(process.env.PORT ?? 4000);
await app.listen(port);
console.log(`In-memory API on http://localhost:${port}/api (nothing is saved)`);
