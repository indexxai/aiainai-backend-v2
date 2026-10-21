# aiainai backend

NestJS API and background worker for **aiainai (AI Station)**. The web app lives in the separate
`aiainai-frontend` repo and calls this API through `/api`.

## Processes

| Process                     | Entry                                   | Port                 | Health            |
| --------------------------- | --------------------------------------- | -------------------- | ----------------- |
| HTTP API                    | `src/main.ts` → `node dist/main.js`     | `PORT` (4000)        | `GET /api/health` |
| Background worker (Inngest) | `src/worker.ts` → `node dist/worker.js` | `WORKER_PORT` (4001) | `GET /health`     |

API reference (Swagger) at `/api/swagger` outside production (`/api/docs` is the Documents API).

## Run locally

Node 22, pnpm 10 (`corepack enable`), Docker.

```bash
cp .env.example .env
docker compose up -d        # MongoDB (replica set), Redis, Inngest dev UI at http://localhost:8288
pnpm install
pnpm start:dev              # API on :4000
pnpm start:worker:dev       # worker on :4001 (second terminal)
```

**Without Docker or MongoDB** (frontend work, demos): `pnpm dev:memory` runs the real API on :4000 with
in-memory storage and the stand-in model. Sign-up codes are printed in the terminal; nothing is saved.
Options: `FAKE_PLAN=pro`, `FAKE_CREDITS=10`, `DEMO_DELAY_MS=60`.

## Commands

| Command                                      | What it does                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | Checks (all run in CI)                                                                            |
| `pnpm build`                                 | Compile to `dist/`                                                                                |
| `pnpm openapi`                               | Regenerate `openapi.json` (the frontend builds its typed client from it). CI fails if it's stale. |

## Layout

```
src/
  main.ts / worker.ts     process entry points
  app.module.ts           API root module (feature modules are added here)
  worker.module.ts        worker root module
  config/                 environment validation (zod)
  database/               MongoDB connection, schemas, workspace scoping (see docs/DATA_MODEL.md)
  credits/                credits ledger: grant, hold, settle, release, expire
  workspaces/             workspace + profile creation for new users
  models/                 starting model registry
  plans/                  plan limits
  health/                 /api/health
  jobs/                   Inngest client and background functions
```

See `docs/ARCHITECTURE.md` and `docs/HOSTING.md`.
