# Backend architecture

```
aiainai-frontend (Next.js) ──/api──▶ API (NestJS) ──▶ MongoDB Atlas (data, credits ledger, vector search)
                                         │          ├─▶ Redis (rate limits, cache)
                                         │          ├─▶ Object storage (files, images)
                                         │          └─▶ AI providers via the model gateway
                                         └─ events ─▶ Inngest ─▶ Worker (NestJS context): agents, research,
                                                                 file reading, images, schedules, emails
```

## Modules (planned, added as each MVP task lands)

| Module                         | Responsibility                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `auth`                         | Better Auth: email codes, Google, sessions. Users carry a reserved slot for a future indexx account link (OpenID Connect). |
| `models`                       | Model registry (names, providers, plans, credit prices, availability) managed from Admin                                   |
| `gateway`                      | Model gateway: Auto choice, fallback, streaming, credits hold → charge → refund, usage logging                             |
| `credits` / `billing`          | Append-only credits ledger in transactions with idempotency keys; Stripe plans, top-ups, webhooks                          |
| `chat`                         | Threads, messages, streamed answers (SSE), sharing                                                                         |
| `files`                        | Upload, text extraction, Atlas Vector Search, answers with citations                                                       |
| `docs` / `images` / `research` | The content tools                                                                                                          |
| `team`                         | AI Team: Captain Jack, agents, tasks, approvals (Inngest `waitForEvent`), schedules                                        |
| `admin`                        | Owner/Support roles, model and plan editing, people, safety, audit log                                                     |
| `notifications`                | In-app inbox and emails (Resend)                                                                                           |

## Rules

- Long work is an Inngest function, never a long HTTP request.
- Every AI call goes through the `gateway` module, so credits and costs are always recorded.
- Money and credits are never edited in place; corrections are new ledger entries.
- Endpoints are documented with Swagger decorators; `openapi.json` is the contract with the frontend.

## Sign-in (live since day 4)

- Better Auth, mounted at `/api/auth/*` (reached through the web app's domain, so cookies are first-party).
- Email + password sign-up; the account is confirmed with a 6-digit code (10 minutes, 5 attempts, stored hashed) before first sign-in.
- Google sign-in when `GOOGLE_CLIENT_ID/SECRET` are set; a Google login with the same verified email links to the existing account.
- Sessions last 30 days and refresh daily. Auth endpoints are rate limited.
- A new user (any method) gets a workspace and the Free plan's monthly credits.
- Every API endpoint requires a session unless marked `@Public()`; `GET /api/me` returns the person, workspace and credits.
- Better Auth stores its data in the `user`, `session`, `account` and `verification` collections.

## Models and the gateway (live since day 5)

- `GET /api/models?kind=text` returns what the model menu shows: Auto, then each model with its
  credits, tags and a `locked` flag for models outside the workspace's plan, plus the person's
  default (`selected`). Provider model ids and prices are never sent to the browser.
- A model is offered only when it is `live` in the registry, has a provider model id, and its
  provider has a key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`). Turn models on with
  `pnpm models:configure gpt=<openai model id> claude-sonnet=<anthropic model id>`.
- Without keys, local development uses a **stand-in model** that streams a sample answer, so
  credits, streaming and Stop work end to end. It is refused in production.
- `GatewayService.stream()` is the only way to call a text model:
  resolve the model (Auto picks one) → hold credits → stream → settle or release → usage event.
  - Finished answer: charged. Stopped after text arrived: charged. Stopped before any text, or
    failed: credits returned. Errors shown to people never include provider details.
  - Auto is a readable rule: short prompts (≤ 280 characters, no files) go to a fast model
    (Claude Haiku, then GPT mini…), the rest to a balanced one (Claude Sonnet, then GPT…), only
    from models on the person's plan.
- `PATCH /api/me/preferences { textModel }` saves the default model (`auto` or a model key);
  Pro models on Free are refused with `upgrade_required`.

## Chat (live since day 6)

- `POST /api/chats` starts a chat; `GET /api/chats` lists them (pinned first, then newest, `q` searches titles,
  `cursor` pages); `GET/PATCH/DELETE /api/chats/:id` read, rename/pin and delete (soft).
- `POST /api/chats/:id/messages` saves the message and **streams the answer as Server-Sent Events**:
  `ready` → `model` → `delta`… → `done` | `error`. The last event always carries the saved answer, so the
  browser ends in the same state as the database.
- **Stop** = the browser closes the stream. The server notices, stops the model call, and saves the answer
  as `stopped` (charged only if text had arrived). **Continue** carries on a stopped answer;
  **Regenerate / Retry** rewrites the latest answer and keeps the earlier text in `previousVersions`.
- One answer at a time per chat (a second tab gets `409`). Answers still "streaming" after 2 minutes
  (e.g. a restart) show as failed.
- Context: earlier messages, newest first, up to ~60k characters / 40 messages.
- Not enough credits, a Pro model on Free and provider failures are saved on the answer (`error.code`) and
  shown in the conversation with the right action (Top up, Use Auto, Retry).
- Proxies must not buffer `text/event-stream` (we send `X-Accel-Buffering: no` and a heartbeat every 15s).

## Credits renewal and billing page (day 7)

- Plan credits renew monthly, counted from the day the plan started (a plan started on the 31st renews on
  the last day of shorter months). When a period has ended, unused plan credits expire, top-up credits
  stay, and the new month's credits are granted. This runs whenever the workspace is loaded
  (`WorkspacesService.renewIfDue`), every step is idempotent, and months nobody used are skipped.
  Pro renewals will follow the payment webhook once Stripe is connected.
- `GET /api/billing/summary`: plan, credits, storage, credits used by each tool this period.
- `GET /api/billing/history`: AI usage (charged / stopped / failed) and credits added or expired, newest first.

## AI Docs (backend since day 7)

1. `POST /api/docs/outline` {brief, type} → a title and 3–8 headings to check (1 credit, structured output).
2. `POST /api/docs` saves the approved outline with length and tone (or a blank document).
3. `POST /api/docs/:id/write` streams the document as Markdown (SSE, same events as chat with `{doc}` in
   `ready`/`done`/`error`). Each section starts with `## heading`, which is how progress is shown.
   - Price = model credits × length factor (short 2, medium 3, long 5): Claude Sonnet, medium = 6 credits.
     `GET /api/docs/estimates` gives the numbers for the outline screen.
   - Stop keeps the finished sections and charges only for them; calling `write` again continues with the rest.
4. The editor autosaves with `PATCH /api/docs/:id` {title, content (editor JSON), text}. Once edited, the
   editor JSON is the source of truth; the AI Markdown stays as the original draft.
5. AI editing (day 10) — nothing is written to the document until the person accepts:
   - `POST /api/docs/:id/ai/edit` {text, action (shorter/formal/simpler/grammar/translate) or instruction}
     returns a suggested rewrite of the selected text (one message's credits, structured output).
   - `POST /api/docs/:id/ai/assistant` {message, markdown, history} answers about the document, or drafts a
     section to add (`insert`) or a new version of one (`insert.replaces`). The client sends the editor's
     Markdown so unsaved edits count. Documents over 60,000 characters are cut, keeping the sections the
     request names; `truncated` tells the panel to say so.
   - Closing the request cancels the model call and returns the held credits.
6. Sharing (day 10), view only:
   - `PATCH /api/docs/:id/share` {linkAccess: off|view, resetLink} — a random 24-character token; the public
     page `/s/:token` reads `GET /api/public/docs/:token` without signing in (drafts are never shown).
   - `POST /api/docs/:id/share/invites` {emails} adds people (max 50) and emails each a link; they see it under
     "Shared with me" (`GET /api/docs?scope=shared|mine|all`) once signed in with that address, read-only.
     Edits, AI and sharing settings stay with the owner's workspace (others get 404).

## AI Image (day 9)

- `POST /api/images` {prompt, model|auto, ratio, count 1/2/4, hd, style, negative} reserves credits
  (model credits × count) and returns at once with status `generating`; the page polls `GET /api/images/:id`.
- Images are made two at a time. Each finished image is stored (PNG + 512px WebP preview) and charged;
  failed or cancelled images are free. A prompt refused by the provider's safety system ends the batch as
  `blocked`, not charged. `POST /api/images/:id/cancel` stops a batch (works across servers).
- Files are served by `GET /api/images/:id/files/:index` (owner only; `?variant=thumb`, `?format=jpg|webp`,
  `&download=1`).
- Auto for images picks by style: photos → Imagen, illustrations / flat / 3D → FLUX, otherwise GPT Image,
  within the plan. Today only OpenAI image models can be switched on (`pnpm models:configure gpt-image=<id>`);
  Google, Black Forest Labs and ByteDance models are added with their keys.
- Extras (day 11). Each result is a new record (`kind`, `source`), so the original is never changed:
  - **Reference image**: `POST /api/images/references` (raw JPG/PNG/WebP body, 20 MB max, stored as PNG ≤ 2048 px),
    then `reference: {id, use: style|layout|subject}` on `POST /api/images`.
  - **Variations** (`POST /api/images/:id/variations` {index}): four images from one, model price × 4.
  - **Edit** (`POST /api/images/:id/edit` {index, prompt, mask}): the mask is a PNG, white/opaque = change;
    the server turns it into the provider's mask (transparent = change). Model price × 1.
  - Reference, variations and edits need a model that takes an image as input — today OpenAI's GPT Image.
    Auto picks it for these; `GET /api/images/capabilities` says what the plan can use.
  - **Upscale** (2 credits) and **Remove background** (1 credit), Pro only, run through Stability AI
    (`STABILITY_API_KEY`; endpoint paths can be overridden). Without the key the buttons are hidden.
  - **Improve prompt** (`POST /api/images/improve`): free, recorded as usage with 0 credits.

## AI Team set-up (day 12)

Captain Jack's set-up, one team per workspace (`teams`, `agents`):

1. `POST /api/team/setup/analyze` {business} — Jack reads the description (free). Too vague → `clear: false`
   and the page asks for more; otherwise the team is saved as `status: setup` with his options for the
   three questions (what to take on, which tools, how hands-on).
2. `POST /api/team/setup/proposal` {goals, tools, mode} — the agents Jack proposes (1 credit), each with a
   job title, one-line role, icon and 1–2 tools (aiainai's own: AI Docs, AI Image, Web research; or the
   owner's tools). One optional extra agent.
3. `POST /api/team` {agents, mode} — creates the team with the agents kept (Free: up to 3, Pro: 10).
4. `POST /api/team/agents/:id/prepare` — Jack writes each agent's instructions and first tasks (free); the
   "Setting up your team" screen calls it agent by agent. Agents that need an outside tool (Gmail,
   HubSpot…) stay "Needs setup" until connectors exist.

`GET /api/team` returns the team (null before set-up). Model output is cleaned before saving: known icons
only, tools only from the allowed list, unique agent keys.

## AI Team room (day 13)

- `POST /api/team/room` {text}: Captain Jack reads the request with the team list and recent messages and
  answers; for work he returns up to 4 tasks, each for one agent (one message's credits). Tasks are saved
  (`agent_tasks`) and a `plan` message lists them.
- Tasks run in the background, two agents at a time, claimed atomically (safe with several servers). An
  agent does its task with one model call (one message's credits) and returns a document (AI Docs → a new
  document in Docs), an image (AI Image → a new image, charged at the image price) or a written answer.
  Its result is posted as a `result` message; failures (e.g. out of credits) as a Jack `error` message.
- Agents waiting for an outside tool only draft. Sending, publishing and approvals come next (day 14).
- `GET /api/team/room` returns the latest 100 messages, their tasks and agent statuses; `busy` tells the
  page to keep checking. Interrupted tasks are marked failed after 10 minutes. Background work runs in
  the API process for now; it moves to the worker (Inngest) with the hosting set-up.

## AI Team approvals and pause (day 14)

- An agent that would do something outside the team (send an email, publish a post, change a CRM record,
  share) prepares it as an `action` with a title, impact ("Goes to 3 customers"), preview lines and the
  full draft. It only counts when the agent has the outside tool for it (Gmail, Instagram, HubSpot…).
- Whether it waits for the owner follows the team setting: `important` asks before these actions (unless
  the owner chose "Always allow" for that agent and kind), `all` always asks, `auto` goes ahead. The
  request is an `approvals` record and an approval card in the room; the task is `waiting_approval` and
  the agent shows "Needs you".
- `POST /api/team/approvals/:id/approve` {draft?, always?} — approve as is or with edits ("Edit first").
  `POST /api/team/approvals/:id/reject` {reason, next: revise|drop} — revise queues a new version with the
  reason and the last draft; drop ends the task. `GET /api/team/approvals` lists waiting and decided.
- No connectors yet: an approved action is kept, ready to go out when the tool is connected; the room says so.
- `POST /api/team/pause` / `resume`: while paused no agent starts new work and Jack takes no new requests.

## AI Team management (day 15)

- **Direct chat.** `GET/POST /api/team/agents/:id/chat`. Team messages and tasks carry a `channel`
  (null = team room, agent id = direct chat). A direct message makes one task for that agent; its replies
  stay in that channel, and Jack's room history never includes them.
- **Agents.** `POST /api/team/agents/draft` (free call; Jack drafts name, duties, tools and flags a
  duplicate via `sameAs`), `POST /api/team/agents` (plan limit → 403 `upgrade_required`),
  `PATCH /api/team/agents/:id` (name, role, instructions, model, rule, paused) and
  `POST /api/team/agents/:id/remove` (open tasks: Jack reassigns by tool overlap, a chosen agent, or
  cancel; waiting approvals expire). Agents are soft-deleted.
- **Before acting.** Per-agent `rule`: `team` (follow the team mode), `ask` (always), `auto` (never).
  The rule wins over the team mode; in "important" mode the team `safety` switches pick which action
  kinds ask.
- **Settings.** `PATCH /api/team` (name, mode, safety, default model, daily limit 200/500/1000/none),
  `DELETE /api/team` (agents removed, open tasks cancelled, approvals expired; documents and images stay).
- **Daily limit.** Credits spent today are the sum of team message credits since midnight. Over the
  limit, new requests are refused and the worker stops claiming tasks; Jack says so once a day
  (`limitNotice`). Raising the limit wakes the worker.
- **Tasks board.** `GET /api/team/tasks` (latest 100), shown as Planned / In progress / Needs you / Done.

## Runs that outlive the page (polish pass)

- Chat answers and document writing keep going when the browser closes or navigates away. The SSE
  stream is only a view: `sendSse` registers the run in `liveRuns` (src/common/live-runs.ts) under
  `chat:<chatId>` or `doc:<docId>` and keeps draining events after the client leaves, so the result is
  saved and charged as usual.
- Stop is an explicit call: `POST /api/chats/:id/stop` and `POST /api/docs/:id/stop`. It aborts the
  registered run; its stream then ends with `done` and the answer / finished sections saved as stopped.
- Progress is saved about once a second (message `content`, document `markdown`), so a page that comes
  back mid-way shows what's written so far and checks back until it's finished.
- The registry is per process. If Stop lands on an instance that isn't running it (restart, several
  API instances without sticky sessions), the record is marked stopped directly; the run elsewhere
  finishes its current answer. One API instance (or sticky sessions) is fine for the MVP.
- Expired sessions: the app layout redirects to `/signin?expired=1`, where the proxy clears the dead
  session cookie (otherwise it would bounce back to the app) and the form says the session ended.

## AI Docs: Versions and Export (post-MVP 1)

- **Versions** (`doc_versions`, `DocsVersionsService`). A copy of the document is kept:
  the first draft when writing finishes; while editing, the text being replaced, at most every
  5 minutes; before and after an accepted AI change (the editor sends `aiChange` with that save);
  when the person names the current version; and just before a restore (so a restore can be undone).
  Identical text is never saved twice. History window from the plan (`PLAN_LIMITS.historyDays`:
  Pro 90 days, Free 7), pruned when the list is read; named versions are kept. Owners only.
  Endpoints: `GET /api/docs/:id/versions`, `GET …/versions/:versionId`, `POST …/versions` (name),
  `POST …/versions/:versionId/restore`.
- **Export** (`DocsExportService`, `src/docs/export/`). The editor JSON (or the AI's Markdown, if
  never edited) becomes a small block tree (headings, paragraphs with marks and links, nested and
  check lists, quotes, code, rules, tables), rendered to Word (`docx`), PDF (`pdfmake`, bundled
  Roboto fonts, no remote resources) or Markdown. `GET /api/docs/:id/export?format=docx|pdf|md` for
  owners and invitees; `GET /api/public/docs/:token/export` for the share link. Free (no credits).
  PDFs report their page count in `X-Export-Pages`.
- Not yet: "Also save a copy to Files" (needs the Files feature) and "Include the source list"
  (documents don't carry sources until Research lands).
