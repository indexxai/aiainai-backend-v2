# Open decisions and follow-ups

Things parked while the important MVP features are built. Each needs a decision from the
product owner (or a key / account) before it can be finished. Newest at the bottom of each list.

## Decisions needed

| #   | Since  | Area     | Decision                                                                                                                                                                                         |
| --- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Day 9  | AI Image | With only OpenAI keys, Free users can't make images (GPT Image is Pro-only). Add a Google key for Imagen, or put GPT Image on Free.                                                              |
| D2  | Day 11 | AI Image | Edit, Variations and Reference need GPT Image, so Free users don't see them either. Same fix as D1 (GPT Image on Free), or keep them Pro.                                                        |
| D3  | Day 11 | AI Image | Upscale and Remove background use Stability AI (`STABILITY_API_KEY`). Confirm the provider (and buy the key), or pick another. Endpoints not yet tried with a live key.                          |
| D4  | Day 11 | AI Image | A result that's discarded (edit, upscale, cut-out) is still charged, because the provider already did the work. Keep, or refund discarded results.                                               |
| D5  | Day 10 | AI Docs  | Sharing is view-only. Comment and Edit roles (and "Ask to edit") need real-time co-editing — schedule them, or keep view-only.                                                                   |
| D6  | Day 12 | AI Team  | Pricing for Captain Jack's set-up: the business questions and writing each agent's instructions are free; the team proposal costs 1 credit. Confirm.                                             |
| D7  | Day 12 | AI Team  | Team size: Free = Captain Jack + 3 agents (as designed); Pro = 10 agents (our assumption). Confirm the Pro number.                                                                               |
| D8  | Day 12 | AI Team  | Agents that need outside tools (Gmail, HubSpot, Facebook, …) are created with "Needs setup" until connectors exist. Which connectors come first?                                                 |
| D9  | Day 13 | AI Team  | Team room pricing: each message to Jack costs one message's credits, and each agent task one message more (plus the image price when it makes an image). A 3-task request ≈ 4 messages. Confirm. |
| D10 | Day 14 | AI Team  | Approved actions can't go out yet (no Gmail/Instagram/HubSpot connectors). They're kept ready. Which connector to build first (same as D8)?                                                      |
| D11 | Day 15 | AI Team  | Daily credit limit options are 200 / 500 / 1,000 / none, default 500 per team, counted from midnight server time. Confirm the default and whether it should follow the user's time zone.         |
| D12 | Polish | Billing  | The Pro price isn't set, so the billing page shows only "2,000 credits a month" for Pro. Give the monthly price (and currency) to show it there and in Compare plans.                            |

## Keys and accounts still to set on the server

- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` (then `pnpm models:configure`)
- `RESEND_API_KEY` and a verified sending domain (`EMAIL_FROM`)
- `STABILITY_API_KEY` (only if D3 is confirmed)
- Google sign-in: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- GitHub repos `kashirali123/indexx-aiainai-backend` and `-frontend` connected to this session

## Built later (not in the MVP)

- AI Docs: Check facts; "save a copy to Files" on export (needs Files); Comment/Edit sharing (D5)
- AI Image: "Pick object" selection, Save to Files, Add to a document, Copy share link
- AI Team: outside-tool connectors (OAuth), editing agents' tools and rules in depth
