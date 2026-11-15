<p><img src="public/logo.svg" alt="Broadside" width="220"></p>

**One post. Every network.** Broadside is a free, open-source app that publishes one post to many social networks at once, from your browser or from an AI agent over MCP. It runs on your machine, with your own keys.

A broadside is a single printed sheet posted in public, and a ship firing every gun at once. Both fit.

## What it does

Broadside posts to 18 destinations at once: X, Bluesky, Threads, Mastodon, LinkedIn, Instagram, Facebook Pages, TikTok, YouTube, Pinterest, Reddit, Telegram, Discord, Slack, Nostr, Lemmy, DEV and any webhook (Zapier, n8n, Make or your own server). A sandbox destination lets you rehearse without posting anywhere.

It checks every account against that network's rules before it sends anything. If one copy is too long or carries media the network rejects, the post is held and you are told which network and by how much. Give that account its own version and send again.

You can publish now, schedule for later or save a draft. One network failing does not hold up the others. Each target keeps its own status and public link, and you can retry a failed target on its own.

It is also an MCP server. Claude, Cursor, Codex and other MCP clients can list accounts, check a post, publish, schedule and confirm delivery. You type credentials into Broadside, so they stay out of the chat.

It runs as one Node process with one SQLite file. There is no queue, no database server and no account with anyone.

## Run it

Needs Node 22.5 or newer.

```bash
git clone https://github.com/Balackburn/broadside.git
cd broadside
npm install
npm run build
npm start
```

Open http://localhost:3000, go to **Accounts**, and connect a network (or add the sandbox). Then write a post in **Compose**.

For development: `npm run dev`. To prove the whole thing works end to end: `npm run verify`.

## Connect an agent

Create a key under **Connect** in the app, then:

```bash
claude mcp add --transport http broadside http://localhost:3000/mcp --header "Authorization: Bearer bs_your_key"
```

Any Streamable HTTP client works with the same URL and header. A local stdio server is also included; it needs no key and can read media from your disk:

```json
{ "mcpServers": { "broadside": { "command": "npx", "args": ["tsx", "/path/to/broadside/bin/broadside-mcp.ts"] } } }
```

Tools: `list_platforms`, `list_accounts`, `connect_account`, `disconnect_account`, `upload_media`, `list_media`, `check_post`, `create_post`, `get_post`, `list_posts`, `update_post`, `publish_post`, `cancel_post`, `retry_target`, `delete_post`.

## REST API

The same engine over HTTP, under `/api/v1`, with the key as a Bearer token.

```bash
curl http://localhost:3000/api/v1/posts \
  -H "Authorization: Bearer bs_your_key" -H "Content-Type: application/json" \
  -d '{"content": "Hello", "targets": [{"account_id": "acc_…"}], "publish_at": "2026-12-01T09:00:00+01:00"}'
```

| Method and path | Does |
| --- | --- |
| `GET /platforms` | Networks, limits and credential fields |
| `GET, POST /accounts` · `DELETE /accounts/{id}` | Connected accounts |
| `GET, POST /media` · `PATCH, DELETE /media/{id}` | Upload (multipart `file`) or import (`{"url"}`), set alt text |
| `POST /check` | Dry run against each account's rules |
| `GET, POST /posts` · `GET, PATCH, DELETE /posts/{id}` | Create (send an `Idempotency-Key` header), read, edit |
| `POST /posts/{id}/publish` · `/cancel` · `/targets/{targetId}/retry` | Act on a post |
| `GET, POST /keys` · `DELETE /keys/{id}` | API keys |

Responses are `{ "data": … }` or `{ "error": { "code", "message", "details" } }`.

## Networks and what you bring

You connect each account with credentials you create yourself; the app shows the steps for each network. They are encrypted at rest (AES-256-GCM) and never returned by the API.

| Simple (a token, password or URL) | Needs your own developer app |
| --- | --- |
| Bluesky, Mastodon, Telegram, Discord, Slack, Nostr, Lemmy, DEV, Reddit, Webhook | X, Threads, LinkedIn, Instagram, Facebook Pages, TikTok, YouTube, Pinterest |

Things worth knowing before you rely on a network:

- **These connectors are tested against each network's documented API shapes, not against the live networks.** `npm run verify` exercises Mastodon, Bluesky, Discord, Telegram, Slack and the webhook against local stand-ins; the rest are covered by request-shape tests. Try a new account with one post before scheduling many.
- **Instagram, Threads, Slack, DEV, Nostr and TikTok photos fetch media from a public URL.** Set `BROADSIDE_PUBLIC_URL` to where this app is reachable from the internet, or attach media by URL.
- **TikTok and Pinterest restrict unapproved apps:** TikTok posts are private or inbox drafts until the app is audited; Pinterest trial-access pins are visible only to you.
- **LinkedIn tokens last 60 days** and are pasted by hand, so that account needs reconnecting every two months. Threads tokens are refreshed each time Broadside posts.
- **Not supported yet:** video on X, LinkedIn and Facebook; threads and reply chains; first comments; stories; analytics; editing or deleting a post after it is published.

## Configuration

| Variable | Purpose |
| --- | --- |
| `BROADSIDE_PASSWORD` | Require a password for the web app. Set it before exposing Broadside to a network; without it, anyone who can reach the app can post. |
| `BROADSIDE_PUBLIC_URL` | The public address of this app, used for media that networks fetch and for links handed to agents. |
| `BROADSIDE_DATA_DIR` | Where the database, uploads and encryption key live. Default `./data`. Back this folder up. |
| `BROADSIDE_SECRET` | Key material for encrypting credentials. Default: a key file created in the data folder. |
| `BROADSIDE_API_KEY` | A fixed API key for headless installs. |
| `BROADSIDE_TICK_MS` | How often the scheduler looks for due posts. Default 5000. |
| `BROADSIDE_MAX_UPLOAD_MB` | Largest accepted upload. Default 512. |

## How it is built

- `src/lib/platforms/` holds one connector per network: its credential fields, limits and the HTTP calls that publish. Connectors never touch the database, so each is tested with a fake `fetch`.
- `src/lib/posts.ts` is the engine: validate, fan out, record a status per target, retry transient failures. A target is claimed with a compare-and-set before it is sent, so two clocks can never post it twice, and a target interrupted mid-send is failed rather than resent.
- `src/lib/mcp.ts` defines the tools once; `/mcp` (HTTP) and `bin/broadside-mcp.ts` (stdio) both serve them.
- `src/lib/scheduler.ts` is an in-process clock started with the server.

Adding a network is one object that implements `Connector` in `src/lib/platforms/types.ts`, plus a line in the registry and a request-shape test.

## Design

The interface is dark, with a serif display face (Instrument Serif) over Geist. The front page borrows its language from Resend's site: a black ground, hairline cards and a 3D object in the hero. Broadside's version is its own CSS; no fonts, renders or code come from Resend.

Network logos come from the CC0 [Simple Icons](https://simpleicons.org) set and belong to their owners. LinkedIn, Slack and Nostr are not in that set, so they show initials.

## Licence

MIT. There are no paid plans, and no service sits between you and the networks.
