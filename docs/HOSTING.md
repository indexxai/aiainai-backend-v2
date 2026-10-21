# Hosting hand-off (backend)

One Docker image (`docker build -t aiainai-backend .`), run twice:

| Service | Command                       | Port | Health check                                                   |
| ------- | ----------------------------- | ---- | -------------------------------------------------------------- |
| API     | default (`node dist/main.js`) | 4000 | `GET /api/health` → 200 (503 if MongoDB is unreachable)        |
| Worker  | `node dist/worker.js`         | 4001 | `GET /health` → 200 (override the image's default HEALTHCHECK) |

Both are stateless; scale by running more copies. On startup the API waits for MongoDB (10 retries, 3 s apart).

## First deploy of a new database

Run `pnpm seed` once (or `node dist/seed.js` in the image) with the environment's `MONGODB_URI`. It creates indexes and the model registry, and is safe to repeat.

## Routing

- Serve the API behind the web app's domain: the frontend forwards `https://aiainai.ai/api/*` to the API.
  Users never see a second domain, and sign-in cookies stay first-party.
- The worker needs a URL Inngest can reach: `https://<worker-host>/api/inngest`. It does not need to be public otherwise.

## Services to provision

- **MongoDB Atlas**: dedicated aiainai project/cluster (replica set; transactions and Vector Search are used).
- **Inngest** (Cloud or self-hosted): set `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY` on API and worker; register the worker URL. Never set `INNGEST_DEV` outside local.
- Later: Redis, S3-compatible object storage, Stripe webhook endpoint (`/api/billing/webhook`).

## Sign-in and email

- Set `BETTER_AUTH_SECRET` (32+ random characters) and `RESEND_API_KEY` in staging and production; the API refuses to start in production without them.
- In Resend, verify the sending domain (aiainai.ai) and set `EMAIL_FROM`.
- Google sign-in: create an OAuth client in Google Cloud with redirect URI `https://<app domain>/api/auth/callback/google`.

## Environments

Staging and production with separate databases and keys. Every variable is listed in `.env.example`.

## Streaming (chat answers)

Chat answers are `text/event-stream` responses that can last a few minutes. On the load balancer / reverse
proxy in front of the API:

- turn off response buffering for `/api/chats/*` (nginx: `proxy_buffering off;` — the API also sends
  `X-Accel-Buffering: no`);
- set the idle/read timeout to at least 120 seconds (the API sends a heartbeat every 15 seconds);
- don't compress `text/event-stream` responses.

## Image processing and storage

- Generated images are stored in MongoDB GridFS (`STORAGE_DRIVER=gridfs`, collection `files.*`), so no extra
  service is needed for the MVP. If you'd rather use S3 / R2 / Spaces, tell us and we'll add that driver; nothing
  else changes.
- The API uses `sharp` (native image library) for previews and JPG/WebP downloads. The Docker image (Alpine)
  installs the right build automatically.
- Image batches run inside the API process. A batch cut off by a restart is closed within a few minutes and
  its credits are returned automatically.

## v2 staging (branch `v2`)

Deploy the `v2` branch of both repos to staging. Nothing new to provision beyond the keys below; v2 adds
collections (wallets, receipts, jack actions, browser tasks, memories, connections) that are created on first
use, so `pnpm seed` once more is enough.

1. Build and run exactly as above (API + worker from the backend image, frontend with `BACKEND_URL`).
2. Set the v1 variables plus the v2 ones (all are in `.env.example`):

   | Variable                                                                                 | What for                                          | Without it                                        |
   | ---------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------- |
   | `OPENROUTER_API_KEY`                                                                     | Every model maker through one key                 | Only models with a direct OpenAI/Anthropic key    |
   | `COMPOSIO_API_KEY`, `COMPOSIO_AUTH_CONFIG_GMAIL`, `COMPOSIO_AUTH_CONFIG_GOOGLE_CALENDAR` | Gmail and Google Calendar connections             | Connecting is turned off                          |
   | `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`                                          | Jack's browser (hosted browsers with a live view) | Jack's browser is off; Jack doesn't offer to book |

3. After the first deploy, point each model at its OpenRouter id:
   `pnpm models:configure <model>.openrouter=<OpenRouter model id>` (run against the staging database).
4. Payments stay in **test mode** in every environment until card issuing is chosen (OPEN_DECISIONS D21): approving
   a purchase saves a test receipt and moves no money.
5. Outbound network from the API: `openrouter.ai`, `backend.composio.dev`, `api.browserbase.com` and
   `connect.browserbase.com` (WebSocket, for controlling the browser).

### Demo staging before the keys arrive

To show v2 without any keys, run a separate demo instance with `NODE_ENV=development` and `AI_DEMO=true`
(plus `BETTER_AUTH_SECRET` and its own database). It uses the stand-in model, sample Gmail/Calendar data and the
sample browser, exactly like the demo video. Sign-up codes are written to the API log instead of emailed. Never
put real users on it; production refuses these settings.

### Smoke test after deploy

- `GET /api/health` → 200; open the app, sign up, verify, land on Jack's home.
- Ask Jack for "a trip checklist document" → a plan card appears and the document opens in AI Docs.
- With Composio keys: Connections → Connect Gmail → Jack can read the inbox.
- With Browserbase keys: "Find me a flight to Dubai…" → Jack's browser opens with a live view and stops at payment.
