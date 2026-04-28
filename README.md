# Demo Project: RepoBeats

This is a **demo project** that generates a roast-style song for a GitHub username.

The app pulls public GitHub profile signals, writes lyrics, generates audio, and serves a shareable result.

## Cloudflare Products Used

- **Workers** - Runs the API and serves the web app.
- **Workers AI** - Calls models for lyric generation and music generation.
- **AI Gateway** - Routes model calls, applies gateway options, and enables caching controls.
- **Workers KV** - Caches generated songs by GitHub handle so repeat lookups are fast.
- **Rate Limiting Binding** - Limits expensive song generation requests per IP.
- **Workers Static Assets** - Serves the SPA from the `public` directory.

## High-Level Flow

1. User opens the site and submits a GitHub handle + genre.
2. Worker validates input and checks KV for an existing recent song.
3. On cache miss, Worker fetches GitHub repo/commit metadata.
4. Worker generates roast lyrics with Workers AI (through AI Gateway).
5. Worker generates song audio with Workers AI (through AI Gateway).
6. Worker returns the result to the client and writes it to KV for reuse.
7. Shared handle routes can fetch the cached song via API.

## Project Shape

- `src/index.ts` - Worker routes (`/api/generate-song`, `/api/song/:handle`, health).
- `src/github.ts` - GitHub data collection and profile shaping.
- `src/prompting.ts` - Lyric prompt construction and lyric generation.
- `src/music.ts` - Music generation and audio URL extraction.
- `public/` - Frontend SPA.

## Required Secrets

- `API_GW_TOKEN` - Required if your AI Gateway is protected/authenticated.

Set it with:

```bash
npx wrangler secret put API_GW_TOKEN
```

Optional but recommended:

- `GH_TOKEN` - GitHub token used to reduce API rate-limit failures when fetching profile/repo data.

Set it with:

```bash
npx wrangler secret put GH_TOKEN
```

Also required (non-secret config in `wrangler.jsonc`):

- `AI_GATEWAY_ID` var
- `SONGS` KV namespace binding
- `GENERATE_LIMITER` rate limit binding
- `AI` Workers AI binding
- `ASSETS` static assets binding

## Run Locally

```bash
npx wrangler dev
```

## Deploy

```bash
npx wrangler deploy
```
