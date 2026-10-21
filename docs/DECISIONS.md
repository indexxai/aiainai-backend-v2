# Decisions

| #   | Date       | Decision                                                                           | Why                                                                         |
| --- | ---------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | 2026-10-05 | Two repos: `aiainai-frontend` (Next.js) and `aiainai-backend` (NestJS)             | Team preference; separate deploys and access                                |
| 2   | 2026-10-05 | NestJS for the API and worker, TypeScript                                          | Structure for a growing team, dependency injection, Swagger docs            |
| 3   | 2026-10-05 | `openapi.json` is the contract; the frontend generates its typed client from it    | Keeps two repos in sync without publishing a shared package                 |
| 4   | 2026-10-05 | MongoDB Atlas (own project) with Mongoose                                          | Team already runs MongoDB; transactions and Vector Search available         |
| 5   | 2026-10-05 | Better Auth inside NestJS                                                          | Free, users in our own database, email codes + Google                       |
| 6   | 2026-10-05 | aiainai users separate now, linkable to indexx later (OpenID Connect)              | Ship without waiting for a shared identity service                          |
| 7   | 2026-10-05 | Inngest for background jobs, served by a NestJS worker process                     | Durable steps, approvals, schedules, retries for AI Team                    |
| 8   | 2026-10-05 | Hosting and deploys owned by the indexx team                                       | Backend ships as one Docker image, two processes                            |
| 9   | 2026-10-05 | Vercel AI SDK for model calls; OpenAI and Anthropic first                          | One streaming interface for every provider; more providers are one branch   |
| 10  | 2026-10-05 | Provider model ids set by `models:configure`, never hard-coded                     | Provider names change; whoever owns the account picks the exact model       |
| 11  | 2026-10-05 | Stand-in model when no keys are set (local only)                                   | Build and test the full flow before accounts exist                          |
| 12  | 2026-10-05 | Charge per message: finished or stopped-with-text is charged; failures are free    | Simple to explain; matches the "N credits" label in the design              |
| 13  | 2026-10-06 | Chat answers stream over Server-Sent Events from a POST                            | Works through the Next.js proxy and load balancers; Stop = close the stream |
| 14  | 2026-10-06 | `pnpm dev:memory`: the real API on in-memory storage                               | Frontend work and end-to-end tests without MongoDB                          |
| 15  | 2026-10-06 | AI edits are suggestions shown in place; the document changes only on Accept       | People stay in control; no surprise rewrites, no version history needed yet |
| 16  | 2026-10-06 | Sharing is view-only (link or email invite) for the MVP                            | Comment and edit roles need real-time collaboration; added later            |
| 17  | 2026-10-06 | Image edits, variations, upscales and cut-outs are new images linked to the source | Nothing is overwritten; Discard deletes the new one                         |
| 18  | 2026-10-06 | Upscale and Remove background through Stability AI (one key), Pro only             | One provider for both tools; OpenAI has no upscaler                         |
| 19  | 2026-10-06 | One AI Team per workspace; set-up state kept on the team record                    | Matches the design; resuming or starting over is simple                     |
| 20  | 2026-10-06 | Open decisions are tracked in docs/OPEN_DECISIONS.md                               | Keep building the important features; decide parked items together later    |
