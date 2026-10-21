# Data model (MongoDB)

Every collection except `workspaces` and `ai_models` belongs to a workspace (`workspaceId`, required).
Queries go through `scoped(workspaceId, filter)` so one workspace can never read another's records.
Most collections soft-delete (`deletedAt`); a cleanup job removes records 30 days after deletion.
All records have `createdAt` / `updatedAt`.

| Collection          | Holds                                                                                                                                                        | Key indexes                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `workspaces`        | Owner, plan (free/pro), current plan period, Stripe customer                                                                                                 | owner; Stripe customer (unique)                                          |
| `user_profiles`     | Link from a Better Auth user to their workspace; theme; default text model; onboarding answers; reserved `indexxAccountId` for linking indexx accounts later | userId (unique); indexxAccountId (unique when set)                       |
| `projects`          | Folders grouping chats, docs, files, images                                                                                                                  | workspace + recent                                                       |
| `chats`             | Title, chosen model, last activity, share link token                                                                                                         | workspace + recent; share token (unique); title search                   |
| `messages`          | Role, content, status (complete/streaming/stopped/failed/refused), model that answered, credits, attachments, earlier versions, feedback                     | chat + time                                                              |
| `documents`         | Title, type, editor content, plain text, status, sharing (link token, invites)                                                                               | workspace + recent; text search                                          |
| `image_generations` | Prompt, model, ratio, count, style, status, resulting images, credits                                                                                        | workspace + recent                                                       |
| `teams`             | One per workspace: business description, goals, status                                                                                                       | workspace (unique)                                                       |
| `agents`            | Name, role, instructions, model, tools, actions that need approval, status, Captain flag                                                                     | workspace + team                                                         |
| `agent_tasks`       | Title, brief, status, progress, result, background run id, credits, parent task (handoffs)                                                                   | workspace + status; agent + time                                         |
| `approvals`         | What the agent wants to do, the impact in plain words, a preview, decision, expiry                                                                           | workspace + status; task                                                 |
| `ai_models`         | Model registry: key, kind (text/image), provider, provider model id, credits, plans, Auto-eligible, status, provider prices                                  | key (unique); kind + status                                              |
| `usage_events`      | One per AI call: model, tokens, images, provider cost (micro-dollars), credits, latency, outcome, request id                                                 | workspace + time; model + time                                           |
| `credit_accounts`   | Spendable `plan` and `topup` credits and `held` credits per workspace                                                                                        | workspace (unique)                                                       |
| `credit_entries`    | Append-only ledger of every credit movement                                                                                                                  | workspace + idempotency key + bucket (unique); workspace + time; hold id |

Sign-in data is stored by Better Auth in its own collections: `user`, `session`, `account` (sign-in methods: password, Google) and `verification` (email codes, stored hashed).

## Credits

- Two buckets: **plan** (monthly, expires at period end) and **top-up** (bought, rolls over). Plan credits are spent first.
- Paid work: **hold** the estimated credits → do the work → **settle** (charge the actual cost, release the rest) or **release** everything on failure.
- Each operation takes an idempotency key; repeating it (double click, network retry, duplicate webhook) never moves credits twice.
- Balance changes and ledger entries are written in one transaction. Spending uses a conditional update, so concurrent requests can't overspend.
- Reconciliation rule: for each workspace and bucket, the sum of `credit_entries.amount` equals `credit_accounts.<bucket>`, and the sum of `heldDelta` equals `held`.

## Setting up a database

`pnpm seed` builds all indexes and adds the starting model registry (models start `hidden` until their provider keys are set).
It is safe to run again; existing registry entries are not overwritten.

`pnpm models:configure` lists the registry and turns models on once a provider account is ready
(`key=<provider model id>`, `key=off`, `key=pause`, `key.price=IN/OUT` in USD per million tokens).
