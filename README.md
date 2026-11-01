# Username Extractor

Upload Instagram screenshots and get every username in one clean, ready-to-use list.

It reads the handle off each screenshot with a vision model, cleans it, scores how confident it is, and checks your existing leads before saving anything. Facebook, TikTok, and YouTube screenshots work too.

## What you can do

- Drop a whole folder of screenshots and watch progress update per image.
- Get clean handles with a confidence tier, so you can trust or review each one.
- Skip duplicates: near-identical handles are caught, not just exact repeats.
- Keep a lifetime list of leads, filter it, and export it as CSV.
- Sync verified leads to Notion, or import leads from the old Python CLI.

## Requirements

- [Bun](https://bun.sh) to install and run the scripts.
- A Cloudflare account with D1, R2, KV, Queues, and Durable Objects.
- Your own Cloudflare API token with Workers AI access. Extraction runs on your account and is billed to you.
- A Google OAuth client (ID and secret) for sign-in.

## Setup

```bash
git clone https://github.com/Dropout-Studio-Co/username-extractor.git
cd username-extractor
bun install
```

Create a `.dev.vars` file in the project root (it is gitignored) using the variables from [Configuration](#configuration), then apply the database migrations:

```bash
bun run db:migrate:local
```

## Run

```bash
bun run dev       # dev server on http://localhost:5173
bun run preview   # build + wrangler dev, real Workers runtime
```

`bun run dev` has no Workers runtime, so queues, the Durable Object, and the nightly cleanup never fire. Use `bun run preview` when you change the extraction pipeline. Pushes to `main` deploy through Cloudflare Workers Builds.

## Configuration

```bash
# Required
BETTER_AUTH_SECRET=...            # signs sessions: openssl rand -base64 32
BETTER_AUTH_URL=http://localhost:5173
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
NOTION_TOKEN_ENCRYPTION_KEY=...   # encrypts stored tokens: openssl rand -base64 32

# Optional
PUBLIC_GOOGLE_CLIENT_ID=...       # turns on Google One Tap
E2E_BYPASS_AUTH=1                 # local only: skips Google sign-in
```

In production, set the secrets with `wrangler secret put <NAME>`. Never set `E2E_BYPASS_AUTH` there: it turns authentication off.

## Troubleshooting

- **Uploads never move past pending.** You are probably on `bun run dev`. Queues and the Durable Object only run under `bun run preview`.
- **A job refuses to start.** No Cloudflare account is connected. Add your account ID and API token in Settings first; extraction cannot run without them.
- **Google sign-in fails after the redirect.** The redirect URI in the Google Console must match exactly: `<your-url>/api/auth/callback/google`.

## License

[MIT](./LICENSE) © 2026 Dropout Studio
