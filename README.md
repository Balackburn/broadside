<p><img src="public/logo.svg" alt="Broadside" width="220"></p>

**One post. Every network.** Broadside is a free, open-source app that publishes one post to many social networks at once, from your browser or from an AI agent over MCP. It runs on your machine, with your own keys.

A broadside is a single printed sheet posted in public, and a ship firing every gun at once. Both fit.

## What it does

Broadside posts to 18 destinations at once: X, Bluesky, Threads, Mastodon, LinkedIn, Instagram, Facebook Pages, TikTok, YouTube, Pinterest, Reddit, Telegram, Discord, Slack, Nostr, Lemmy, DEV and any webhook destination (Zapier, n8n, Make or your own server). A sandbox destination lets you rehearse without posting anywhere.

It checks every account against that network's rules before it sends anything. If one copy is too long or carries media the network rejects, the post is held and you are told which network and by how much. Give that account its own version and send again.

You can publish now, schedule for later or save a draft. One network failing does not hold up the others. Each target keeps its own status and public link, and you can retry a failed target on its own.

A post can carry a thread: extra parts published in order after the main text, each as a reply to the one before. A first comment is a thread with one extra part. Every part is measured against each network's limit before anything is sent, and a network that cannot thread is refused by name. If part 3 fails, parts 1 and 2 stay recorded and a retry starts again at part 3.

A scheduled post can repeat every day, week or month, with an optional end date. Each time an occurrence goes out, the next is created as its own scheduled post, so you can edit or cancel one without touching the rest, or stop the whole series.

Four things keep a busy install in order:

- **Media library.** Everything you upload or import by link is kept under **Media**, newest first, with its type, size, description and the posts that use it. Attach a file to as many posts as you like with **Choose from library** in the composer. A file that a draft, a scheduled post or a failed post still needs cannot be deleted, and Broadside says how many posts hold it; once those posts are out, it can go.
- **Tags.** A post can carry short names such as `launch` or `weekly`. Type a new one in the composer or pick an existing one, then filter **Posts** and **Calendar** by tag. Renaming a tag renames it on every post. Deleting a tag takes it off its posts and deletes no post. Tags are never published.
- **Account groups.** A group is a named set of connected accounts, such as "Launch day". Make groups under **Accounts**; picking one in the composer selects exactly its accounts. Disconnect an account and its groups have one fewer member.
- **Signatures.** A signature is saved text for the end of a post: a sign-off or a set of hashtags. **Add signature** in the composer puts it into the post text, where you can edit it and it counts toward every network's limit. An account can have a default signature. The composer offers it for that account and adds it only when you ask.

It reads back the numbers. For each published post Broadside asks the network for the counts it holds: views or impressions, likes, comments, shares, saves and clicks, whichever that network reports. **Analytics** shows totals for the last 7, 30 or 90 days, a breakdown by network and a row for each copy of a post, and an expanded post in **Posts** shows its numbers with a **Refresh numbers** action. Every figure is a reading stored with the time it was taken, shown as "as of". Nothing is estimated: a count a network does not report is absent, and a network with no numbers to read is named with the reason. See [Analytics](#analytics).

It can work without being asked each time. **Automations** holds two things: RSS and Atom feeds whose new items become posts, saved as drafts unless you choose otherwise, and outgoing webhooks, which tell your other tools when a post is published, fails or is scheduled. See [Automations](#automations).

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

`npm start` listens on this machine only. To reach Broadside from other devices, set a password and say where it lives:

```bash
BROADSIDE_HOST=0.0.0.0 BROADSIDE_PASSWORD='choose-something' BROADSIDE_PUBLIC_URL='https://post.example.com' npm start
```

It refuses to listen on a network without a password.

One person can run all of this alone. To let other people in with their own sign-in and their own limits, see [Teams](#teams).

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

Tools: `list_platforms`, `list_accounts`, `list_groups`, `connect_account`, `disconnect_account`, `upload_media`, `list_media`, `list_tags`, `list_signatures`, `check_post`, `create_post`, `get_post`, `list_posts`, `update_post`, `publish_post`, `cancel_post`, `stop_series`, `retry_target`, `delete_post`, `get_analytics`, `get_post_analytics`, `list_feeds`, `list_outgoing_webhooks`.

`get_analytics` (a period of 7, 30 or 90 days, and optionally an account or a tag) and `get_post_analytics` are read-only. They report the readings Broadside has stored and ask no network.

`list_feeds` and `list_outgoing_webhooks` are read-only, and there is no tool that adds, changes, checks or deletes a feed or an outgoing webhook: either could send your posts somewhere or publish words you did not write, so they are set up by a person in the app. An agent sees the site an outgoing webhook calls, never its full address or its secret. `list_posts` takes `origin` and `feed_id` to find the posts a feed made. An agent can edit a draft made from a feed and cannot publish it.

`create_post` and `update_post` take `tags`, and `group_id` in place of `targets` to post to a saved group. `check_post` takes `group_id` too, and `list_posts` filters by `tag`. A signature is text: an agent that wants one reads it from `list_signatures` and puts it at the end of the post itself.

On an install with a [team](#teams), a key has a role and each tool needs one: a viewer's key can list and read, an editor's can also write and publish, and only an admin's can connect or disconnect an account. A tool called with too low a role answers with the role it needs and does nothing.

## REST API

The same engine over HTTP, under `/api/v1`, with the key as a Bearer token.

```bash
curl http://localhost:3000/api/v1/posts \
  -H "Authorization: Bearer bs_your_key" -H "Content-Type: application/json" \
  -d '{"content": "Hello", "targets": [{"account_id": "acc_…"}], "publish_at": "2026-12-01T09:00:00+01:00"}'
```

Add `"thread": ["second part", "third part"]` for a thread, and `"repeat": {"every": "week", "until": "2027-06-30", "timezone": "Europe/Paris"}` to repeat a scheduled post (`every` is `day`, `week` or `month`; `until` and `timezone` are optional). A post comes back with its `thread`, its `repeat` and `series`, and for each target a `parts` list with the status and url of every part.

Add `"tags": ["launch", "weekly"]` to tag a post; a tag that does not exist yet is created, and a post comes back with its `tags`. Send `"group_id": "grp_…"` instead of `targets` to post to every account in a group. `GET /posts?tag=launch` lists the posts carrying a tag.

| Method and path | Does |
| --- | --- |
| `GET /platforms` | Networks, limits and credential fields |
| `GET, POST /accounts` · `PATCH, DELETE /accounts/{id}` | Connected accounts. `POST` takes `{"platform", "credentials"}` with tokens you made yourself. `PATCH` takes `{"signature_id"}` to set the signature an account offers by default, or `null` to clear it |
| `POST /oauth/{platform}/start` | Begin a sign-in with your app's id and secret; returns the address to open in a browser |
| `GET, POST /oauth/choices/{id}` | After a sign-in that ends in a choice: what is on offer, and `{"choices": [ids]}` to connect them |
| `GET, POST /media` · `PATCH, DELETE /media/{id}` | The library, newest first, each file with the posts that use it (`used_by`). Upload (multipart `file`) or import (`{"url"}`), set alt text. `DELETE` is refused while a post that has not gone out still uses the file |
| `GET, POST /tags` · `PATCH, DELETE /tags/{id}` | Tags with how many posts carry each. `POST` and `PATCH` take `{"name"}`. `DELETE` takes the tag off its posts and deletes no post |
| `GET, POST /groups` · `GET, PATCH, DELETE /groups/{id}` | Account groups. `POST` and `PATCH` take `{"name", "account_ids"}` |
| `GET, POST /signatures` · `PATCH, DELETE /signatures/{id}` | Saved signatures. `POST` and `PATCH` take `{"name", "content", "default_for"}`, where `default_for` lists the accounts that offer it by default |
| `POST /check` | Dry run against each account's rules |
| `GET, POST /posts` · `GET, PATCH, DELETE /posts/{id}` | Create (send an `Idempotency-Key` header), read, edit. `GET /posts` also takes `origin` (`ui`, `api`, `mcp` or `feed`) and `feed_id` |
| `POST /posts/{id}/publish` · `/cancel` · `/targets/{targetId}/retry` | Act on a post. `/cancel` with `{"series": true}` stops a whole repeating series |
| `GET /analytics` | Totals, a per-network breakdown and one row per published copy of a post. Takes `period` (7, 30 or 90 days, by publish time; default 30), and optionally `account_id` and `tag`. Reads stored readings only |
| `GET /posts/{id}/analytics` · `POST /posts/{id}/analytics/refresh` | One post's numbers per published target, each with `as_of`. `refresh` asks the networks now and says how each reading went |
| `GET, POST /feeds` · `GET, PATCH, DELETE /feeds/{id}` | Feeds. `POST` takes `{"url", "account_ids"` or `"group_id", "template", "action"}`; `action` is `draft` (the default) or `publish`. `PATCH` takes the same except `url`, and `{"paused": true}` or `false` to pause and resume. Each feed comes back with `last_checked_at`, `last_error`, `next_check_at` and the `posts` it created |
| `POST /feeds/{id}/check` · `/test` | `check` reads the feed now and makes posts from what is new. `test` is a dry run: the post the newest item would make and whether it fits, with nothing saved or sent |
| `GET, POST /outgoing-webhooks` · `GET, PATCH, DELETE /outgoing-webhooks/{id}` | Outgoing webhooks. `POST` takes `{"name", "url", "events"}` and answers with the signing `secret`, this once. `PATCH` takes the same fields and `{"paused": true}` or `false`. Each comes back with its latest `deliveries` |
| `POST /outgoing-webhooks/{id}/test` | Sends a signed test delivery now and returns how the receiver answered |
| `GET, POST /keys` · `DELETE /keys/{id}` | API keys. In a team, `POST` also takes `{"role"}`, and each key comes back with `member_id`, `role` and its `owner`'s name |
| `GET, POST /team` | The team as the person asking may see it: `team`, `me`, `members`, and for admins the `invites` still waiting. `POST` takes `{"name", "password"}` and starts a team, once |
| `POST /team/invites` · `DELETE /team/invites/{id}` | Invite someone with `{"name", "role"}`; the reply holds the one-time link, this once. `DELETE` withdraws it |
| `PATCH, DELETE /team/members/{id}` | `{"role"}`, or `{"disabled": true}` or `false`. `DELETE` removes the member and their API keys; the posts they wrote stay |
| `POST /team/password` | A member changes their own password with `{"current", "next"}` |

Responses are `{ "data": … }` or `{ "error": { "code", "message", "details" } }`. A call the caller's role does not allow answers 403 with the code `forbidden` and the role it needs. The `/team` routes answer only to a person signed in to the app, never to an API key, and say so with the code `needs_person`. The [Teams](#teams) section lists the role each route asks for.

## Networks and what you bring

You connect each account with credentials you create yourself; the app shows the steps for each network. They are encrypted at rest (AES-256-GCM) and never returned by the API.

| Simple (a token, password or URL) | Needs your own developer app |
| --- | --- |
| Bluesky, Mastodon, Telegram, Discord, Slack, Nostr, Lemmy, DEV, Reddit, Webhook | X, Threads, LinkedIn, Instagram, Facebook Pages, TikTok, YouTube, Pinterest |

The networks in the second column connect by signing in. You paste your app's id and secret, press **Continue with** the network, approve on its own page, and land back in Broadside connected. Broadside has no app of its own with any network, so nothing is shared with anyone else's install. The dialog shows the exact redirect address to register in your app and the permissions it will ask for.

| Network | Redirect address on your own machine | How long a sign-in lasts |
| --- | --- | --- |
| X | `http://127.0.0.1:3000` (X refuses `localhost`) | Two hours at a time, renewed each time Broadside posts. Lapses after about six months without a post. |
| LinkedIn | `http://localhost:3000` | 60 days, then reconnect. Apps LinkedIn has approved for refresh tokens are renewed for a year. |
| Threads | None: https only | 60 days, refreshed each time Broadside posts. |
| Facebook Pages, Instagram | `http://localhost:3000`, while the Meta app is in development mode | The Page token does not expire. |
| YouTube | `http://localhost:3000` or `http://127.0.0.1:3000` | Until you revoke it. Seven days while the Google app's consent screen is in Testing. |
| Pinterest | `http://localhost:3000` | 30 days, renewed when Broadside posts. Lapses after 60 days without a post. |
| TikTok | The address shown in the dialog | Renewed each time Broadside posts. |

Broadside answers on both `localhost` and `127.0.0.1`, and uses the one each network accepts whichever you browse by. With `BROADSIDE_PUBLIC_URL` set, that address is used for every network.

After signing in to Facebook or Instagram you pick which Pages or Instagram accounts to connect, and each becomes its own account. Pinterest asks which board to pin to. YouTube connects the channel of the Google account you signed in with.

Threads accepts only https redirect addresses, so on `http://localhost` its dialog asks for a token from the Threads User token generator instead. Every sign-in network can also be connected with tokens you made by hand: choose **Paste tokens instead** in the dialog, or send them to `POST /api/v1/accounts`. `GET /api/v1/platforms` lists the fields for each under `oauth.paste`. X accounts connected with the four OAuth 1.0a keys keep working.

Things worth knowing before you rely on a network:

- **Numbers are tested the way posting is: against documented shapes and stand-ins, not live networks.** `npm run verify` reads numbers end to end from stand-in Mastodon, Bluesky, Discord, X, Facebook and Pinterest; the rest are covered by request-shape tests. Bluesky's and Reddit's numbers were written from the published lexicon and Reddit's JSON wiki, without their reference pages to hand, so check those two against one post first. DEV documents only a reaction count, so comments and page views are not read. Where a network leaves a field out of a post nobody reacted to or shared (Discord's reactions, Facebook's shares), Broadside reads that as none.

- **These connectors are tested against each network's documented API shapes, not against the live networks.** `npm run verify` exercises Mastodon, Bluesky, Discord, Telegram, Slack and the webhook against local stand-ins, and the sign-in of X, LinkedIn, Facebook Pages, Instagram, YouTube and Pinterest against stand-ins that behave as those networks document; the rest are covered by request-shape tests. No sign-in has been run against a live network from this repository. Try a new account with one post before scheduling many.
- **Threads work on 11 networks.** X, Bluesky, Mastodon, Threads, Telegram, Reddit, Lemmy and Nostr publish each part as a reply to the one before. Facebook Pages, Instagram and LinkedIn publish each part as a comment under the post. Some need an extra permission: `pages_manage_engagement` on Facebook, `instagram_manage_comments` on Instagram and `threads_manage_replies` on Threads. Discord, Slack, TikTok, YouTube, Pinterest, DEV and the webhook cannot take a thread. `npm run verify` proves threads against the Mastodon, Bluesky and Telegram stand-ins; the other eight are covered by request-shape tests.
- **Repeating posts count their dates from the first occurrence.** A monthly post set for the 31st goes out on the last day of shorter months and returns to the 31st. With a time zone the post keeps its local clock time when the clocks change; without one the dates are counted in UTC. Occurrences missed while Broadside was not running are skipped, so the next one is always in the future.
- **Instagram, Threads, Slack, DEV, Nostr and TikTok photos fetch media from a public URL.** Set `BROADSIDE_PUBLIC_URL` to where this app is reachable from the internet, or attach media by URL.
- **TikTok and Pinterest restrict unapproved apps:** TikTok posts are private or inbox drafts until the app is audited; Pinterest trial-access pins are visible only to you.
- **LinkedIn signs you in for 60 days.** Unless LinkedIn has approved your app for refresh tokens, that account needs reconnecting every two months, and Broadside marks it when the time is up. Threads tokens are refreshed each time Broadside posts.
- **A sign-in that is renewed by posting lapses if nothing is posted.** X after about six months, Pinterest after 60 days. Reconnect the account when that happens.
- **Not supported yet:** video on X, LinkedIn and Facebook; media on the later parts of a thread; stories; numbers for the later parts of a thread, or over time as a chart; editing or deleting a post after it is published.

## Analytics

Broadside reads a post's numbers from the network it was published to, using that network's own API and the account's own credentials. It reads them when you press **Refresh numbers**, and by itself for 30 days after a post goes out: about once an hour for each post, a few posts at a time, beside publishing and never ahead of it. A network that answers "too many requests" is left alone for as long as it asks. If a reading fails, the last good numbers stay with their time, and the reason is shown next to them.

A thread is counted by its first part. Totals add up the latest reading of each post, one kind of count at a time. Views and impressions are separate totals, and so is a score, because networks mean different things by them. Each total names the networks it leaves out and why.

| Network | What it reports | What it needs |
| --- | --- | --- |
| X | Impressions, likes, replies, reposts, quotes, bookmarks | Each read is billed from your X API credits. Without credits X refuses, and Broadside shows its answer |
| Bluesky | Likes, replies, reposts, quotes | Nothing more |
| Mastodon | Favourites, replies, boosts, and quotes from Mastodon 4.5 | `read:statuses` for followers-only posts. Public and unlisted posts are read without it |
| Threads | Views, likes, replies, reposts, quotes | `threads_manage_insights` |
| Instagram | Views, likes, comments, shares, saves | `instagram_manage_insights`. Instagram can take up to 48 hours to report |
| Facebook Pages | Reactions, comments, shares; views and clicks | `read_insights` for views and clicks. The other three are read without it |
| YouTube | Views, likes, comments | `youtube.readonly`, which sign-in already asked for |
| TikTok | Views, likes, comments, shares | `video.list`, and a post that is public. A draft in your TikTok inbox has no numbers |
| Pinterest | Impressions, saves, pin clicks, over the last 90 days | `pins:read` |
| Reddit | Score, comments | Nothing more |
| Lemmy | Upvotes, score, comments | Nothing more |
| DEV | Reactions | Nothing more |
| Discord | Reactions, added up across emoji | Nothing more |

Not available, and shown as such instead of zeros:

- **LinkedIn.** Post statistics need the permission `r_member_postAnalytics`, which LinkedIn gives only to apps it has approved for its Community Management API. An app with Share on LinkedIn alone cannot read them.
- **Telegram.** The Bot API has no way to ask for a message's views or reactions.
- **Nostr.** A note has no count. Reactions and replies are separate notes spread across relays, and no relay holds them all.
- **Slack and the webhook.** They receive a post and report nothing back.

**Accounts connected before analytics.** Threads, Instagram, Facebook Pages, TikTok and Pinterest now ask for one more permission when you sign in (the ones in the table). Accounts you connected earlier do not have it. They keep posting as before; their numbers show the network's refusal with a note to reconnect, and Facebook Pages still show reactions, comments and shares. Reconnect an account to grant the permission. A TikTok app must have `video.list` added to it first, or list its scopes without it in the Scopes field and go without TikTok numbers.

## Automations

Two things under **Automations** run by themselves, from the same in-process clock that publishes scheduled posts.

### Feeds

Add the address of an RSS 2.0, RSS 1.0 or Atom feed, choose the accounts or an account group, and write the post text with `{title}`, `{link}` and `{summary}` where the item's own words go. Each new item becomes a post to those accounts. By default it is saved as a draft for you to read; choose **Publish** and it goes out as soon as Broadside sees it.

- **Nothing from the past.** Everything in the feed when you add it is left alone. An item counts as new when it appears later and, if it carries a date, that date is after the feed was added. Resuming a paused feed starts from that moment in the same way.
- **Never twice.** An item is known by its guid (RSS) or id (Atom), in any capitalisation, or by its link when it has neither. Broadside remembers the items under the feed's address, so a feed you delete and add again does not post them a second time, and the same address cannot be added twice.
- **Nothing trimmed.** If an item's text does not fit one of the chosen networks, the whole post is saved as a draft with the reason, even when the feed publishes. It cannot be published until you have shortened it or changed its accounts.
- **At most every 15 minutes.** A feed is read no more often than that. **Check now** reads it at once. A feed that fails records why, and the wait before the next try doubles from 30 minutes up to a day. One check makes at most five posts; the rest follow at the next checks.
- **Polite fetching.** Broadside sends `If-None-Match` and `If-Modified-Since`, stops reading at 2 MB, and gives up after 15 seconds. It reads the newest 50 items.

A post made from a feed has `"origin": "feed"` and a `feed` with the feed's id, so it can be filtered in **Posts**, over REST and by an agent. Titles and summaries are reduced to plain text before they are put into a post: markup, scripts and styles are removed.

A feed set to publish posts other people's words under your name without anyone reading them. Use it for feeds you write yourself.

### Outgoing webhooks

An outgoing webhook is an address Broadside calls when something happens to a post. It is the reverse of the **Webhook** network under Accounts, which is a destination that receives the posts themselves.

Events: `post.published`, `post.partial` (some networks failed), `post.failed`, `post.scheduled` (also when a scheduled post is edited, and for each new occurrence of a repeating post) and `target.failed` (one network failed for good). Each delivery is a JSON `POST`:

```json
{ "id": "dlv_…", "event": "post.published", "created_at": "2026-12-01T09:00:02.114Z", "post": { "id": "post_…", "status": "published", "targets": [] } }
```

`post` is the post exactly as `GET /api/v1/posts/{id}` returns it, which holds no credentials. `target.failed` adds `target`, the one that failed, with its `error`.

Every delivery is signed with that webhook's own secret, shown once when you add it. To change a secret, delete the webhook and add it again.

| Header | Holds |
| --- | --- |
| `X-Broadside-Event` | The event name |
| `X-Broadside-Delivery` | The delivery id. A retry carries the same id, so a receiver can drop one it has already handled |
| `X-Broadside-Timestamp` | When this try was sent, in seconds since 1970 |
| `X-Broadside-Event-Signature` | `v1=` and the HMAC-SHA256, in hex, of `<timestamp>.<delivery id>.<body>` keyed with the secret |

To check a delivery, compute that HMAC over the raw body and compare it in constant time, then refuse it if the timestamp is more than five minutes from your clock. The timestamp is part of what is signed, so a captured request cannot be replayed later with a fresh one.

```js
const expected = "v1=" + crypto.createHmac("sha256", secret).update(`${timestamp}.${deliveryId}.${rawBody}`).digest("hex");
const ok = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) && Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
```

A delivery that fails (anything but a 2xx answer within 10 seconds) is tried again after 30 seconds, 2 minutes, 10 minutes and an hour, then given up on. After five deliveries in a row are given up on, the webhook is paused and says why; send a test, then resume it. A paused webhook is sent nothing, and events from that time are not kept for later. Each webhook shows its latest 25 deliveries with their status, time, response code and attempt, and **Send a test** sends one now.

Deliveries are queued when the event happens and sent by the clock a few seconds later, so a receiver that is slow or down never delays or fails a post. Events are not guaranteed to arrive in order; each carries its own time.

Both are tested the way the connectors are: `npm run verify` runs them end to end against a stand-in feed and a stand-in receiver on this machine, and the unit tests cover the reader with sample RSS and Atom documents. Neither has been run against a live feed or a live receiver from this repository, so try a new feed in draft mode first.

## Teams

Broadside starts with one operator and stays that way until you decide otherwise. An install that never adds a member works exactly as described above, with nothing new to set up. A team lets several people use one install, each with their own name, their own password and a role.

### Roles

Each role can do everything the ones below it can.

| Role | Can |
| --- | --- |
| `viewer` | Read everything in the app: posts, the calendar, analytics, media, the accounts list, feeds and outgoing webhooks. Change nothing |
| `editor` | Write, schedule, publish, cancel and retry posts. Upload and delete media. Manage tags, groups and signatures |
| `admin` | Connect and remove network accounts. Make and revoke API keys. Add and change feeds and outgoing webhooks. Invite people, and disable, remove or change the role of editors and viewers |
| `owner` | Everything, including admins and other owners |

There is always at least one owner who can sign in: the last one cannot be disabled, demoted or removed, by anyone, themselves included. Nobody changes their own role or disables themselves. An admin can hand out a role up to admin, and cannot touch an owner or another admin.

### Start a team

Open **Team** in the app, type the name you want to sign in with and a password of at least 12 characters, and press **Set up a team**. You become the owner. That request is allowed the same way every request was until then: from this machine when there is no password, or from a session the shared password started.

From that moment:

- Everyone signs in with their own name and password, on this machine too, even with no `BROADSIDE_PASSWORD` set.
- `BROADSIDE_PASSWORD` no longer signs anyone in. `npm start` still asks for it before it will listen on a network: if the team is ever dissolved, the install falls back to that password and is never left open.
- Posts say who wrote them, in the Posts list and on each post.

### Invite people

An owner or an admin presses **Invite someone**, types a name and picks a role no higher than their own. Broadside shows a link, once. Send it to that person somewhere private. They open it, choose their own password, and are signed in.

There is no email. The link holds 32 random bytes, only a hash of it is stored, it works once and it runs out after seven days. Whoever has the link can use it, so treat it like a password until it has been used. An admin never sees or sets anyone else's password. Invites that are still waiting are listed on the Team screen with **Revoke** beside each, and an invite is withdrawn by itself if whoever made it is disabled, removed, or demoted below the role it gives.

Names are compared without capitals or extra spaces, so `Ada`, `ada` and ` ADA ` are one member.

A member changes their own password on the Team screen by typing the current one. That signs them out everywhere else.

### What each role can do

| Area | Action | Least role |
| --- | --- | --- |
| Posts | Read posts, one post, the calendar; dry-run a post with `POST /check` | viewer |
| Posts | Create, edit, schedule, publish, cancel, stop a series, retry a target, delete from history | editor |
| Analytics | Read stored numbers | viewer |
| Analytics | Ask the networks for a post's numbers now (`/analytics/refresh`) | editor |
| Media | List the library | viewer |
| Media | Upload, import by link, set alt text, delete | editor |
| Tags, groups, signatures | List | viewer |
| Tags, groups, signatures | Create, change, delete; set an account's default signature | editor |
| Accounts | List accounts and networks | viewer |
| Accounts | Connect by pasting credentials or by signing in, pick Pages or boards, disconnect | admin |
| API keys | List, create, revoke | admin |
| Feeds | List, with the address cut at its query below admin | viewer |
| Feeds | Add, change, pause, check now, preview, delete | admin |
| Outgoing webhooks | List with their delivery logs, the address cut to its site below admin | viewer |
| Outgoing webhooks | Add, change, pause, send a test, delete | admin |
| Team | See the members and their roles; change your own password | viewer |
| Team | Invite, revoke an invite, disable, enable, remove or change the role of editors and viewers | admin |
| Team | The same for admins and owners; give the owner role | owner |
| Team | Set up the team in the first place | the operator, before there is one |

The line is drawn once, in the wrapper every API route goes through, and each route declares the least role that may call it. `npm run check:routes`, which `npm run verify` runs, fails for a route that declares none. The screens leave out what a member cannot do, and the API refuses it whatever a screen shows.

Over MCP: `list_platforms`, `list_accounts`, `list_media`, `list_tags`, `list_groups`, `list_signatures`, `check_post`, `get_post`, `list_posts`, `get_analytics`, `get_post_analytics`, `list_feeds` and `list_outgoing_webhooks` need viewer. `upload_media`, `create_post`, `update_post`, `publish_post`, `cancel_post`, `stop_series`, `retry_target` and `delete_post` need editor. `connect_account` and `disconnect_account` need admin. `BROADSIDE_MCP_DRAFTS_ONLY` applies on top of this: with it set, no role lets an agent publish.

### API keys in a team

A key made in a team belongs to the member who made it and has a role chosen at that moment, never higher than their own. On every request the key can do the lower of that role and whatever its owner's role is now. Lower the member's role and the key drops with it; disable or remove the member and the key stops working. Posts made with a key are recorded as its owner's.

Keys made before the team had no owner and could do everything. Once there is a team they keep working as **editors that belong to no one**: they can still read and post, which is what they were made for, and can no longer connect accounts, make keys or change feeds and webhooks. The Connect screen marks each as created before the team, with Revoke beside it. `BROADSIDE_API_KEY` is treated the same way. No API key of any role can add a member, change a role or set a password: the team's own routes answer only to a person signed in to the app.

The local stdio server opens the data folder directly, so whoever starts it could already read and change everything in that folder; no role can bind that person. What its role limits is the agent they hand it to. With no team it is the owner, as before. In a team it works as an editor that belongs to no one, unless `BROADSIDE_API_KEY` in its environment holds a member's key, in which case it works as that key does over HTTP, and its posts are recorded as that member's.

### Recovery, on the server

These run on the machine that holds the data folder (`BROADSIDE_DATA_DIR`, or `./data`), with the app running or stopped. They ask for no password, because whoever can run them can already read that folder.

```bash
npm run members -- list              # every member, their role, and whether they are disabled
npm run members -- reset <name>      # throw away a password and print a one-time link to choose a new one
npm run members -- disable <name>    # sign a member out everywhere and stop their API keys
npm run members -- enable <name>     # let a disabled member sign in again
npm run members -- leave-team --yes  # remove every member and go back to one operator
```

`reset` never takes a password on the command line. It signs the member out at once and prints a link like an invite's, which they open to choose a new password. Set `BROADSIDE_PUBLIC_URL` when you run it so the link starts with this Broadside's real address. `disable` refuses the last owner; use `reset` to get an owner back in.

`leave-team` removes every member and invite, and every API key a member made (a viewer's key must not come back as a key with no limits). Posts, accounts, media, automations and the keys from before the team stay, and those keys can do everything again. Afterwards the install is single-user: behind `BROADSIDE_PASSWORD` if it is set, and open on this machine if it is not.

## Configuration

| Variable | Purpose |
| --- | --- |
| `BROADSIDE_PASSWORD` | Password for the web app. Required before Broadside will listen beyond this machine. Once there is a [team](#teams) it signs no one in, and is still required by `npm start` for a network address. |
| `BROADSIDE_HOST` | Address to listen on. Default `127.0.0.1`. |
| `PORT` | Port to listen on. Default `3000`. |
| `BROADSIDE_PUBLIC_URL` | The public address of this app. Used for media that networks fetch, for links handed to agents, and as an allowed host name. |
| `BROADSIDE_ALLOWED_HOSTS` | Extra host names a passwordless install answers to, comma separated. |
| `BROADSIDE_DATA_DIR` | Where the database, uploads and encryption key live. Default `./data`. Back this folder up. |
| `BROADSIDE_SECRET` | Key material for encrypting credentials and signing sessions. Default: a key file created in the data folder. |
| `BROADSIDE_API_KEY` | A fixed API key for headless installs. In a team it works as an editor that belongs to no one. Set in the stdio server's environment to a member's key, it makes that server act as that member. |
| `BROADSIDE_MCP_DRAFTS_ONLY` | Set to `1` and agents can prepare posts but only a person can publish them, from the app. |
| `BROADSIDE_ALLOW_PRIVATE_FETCH` | Set to `1` to let Broadside call addresses on your own network, such as an n8n webhook on localhost or a Mastodon instance on your LAN. |
| `BROADSIDE_TICK_MS` | How often the scheduler looks for due posts. Default 5000. |
| `BROADSIDE_MAX_UPLOAD_MB` | Largest accepted upload. Default 512. |

## Security

Broadside holds the keys to your social accounts, so this is how it protects them and where the edges are.

Without a password it is a local tool. It listens on `127.0.0.1`, and it only answers requests addressed to `localhost`, which stops a web page from reaching it by pointing its own domain at your machine. Any program already running as you on the same machine can still use it; that is the same trust you give the data folder.

With a password, the web app needs a signed session cookie that expires after 30 days. Wrong passwords are slowed down rather than locked out, so guessing is expensive and you can always get in with the right one. Sign out clears the session in that browser; to end every session at once, change the password. API and MCP callers always need a key; keys are 192 bits, stored hashed and shown once.

With a team, each member has their own password. It is hashed with scrypt (N = 32768, r = 8, p = 3) under a salt of its own, and the cost is stored beside the hash so it can be raised later. Passwords are 12 to 200 characters. A wrong name and a wrong password get the same answer after the same work, so sign-in does not reveal which names exist; wrong attempts are counted per name and slow that name first, and nobody is locked out. A session cookie names its member and is signed with the server's secret together with that member's password hash, so changing a password or disabling a member ends their sessions everywhere on the next request. The cookie holds no role: the role is read from the database on every request, so a change holds at once, for sessions, for keys and for agents. The cookie has the same flags as before: HttpOnly, SameSite=Lax, and Secure over https. Every route that changes the team asks for a session from Broadside's own pages, so no other site and no API key can add a member, change a role or set a password.

Credentials are encrypted with AES-256-GCM and never returned by any API. The data folder is created readable by its owner only.

Uploads are checked by their bytes, not their name, and only real images and videos are kept. They are served with a sandboxing policy, so a stored file is shown and never run. Every page carries a closed content security policy and cannot be framed.

Outbound requests to addresses you type (media to import, a Mastodon instance, a webhook, a feed, an outgoing webhook) are refused if they point at this machine or a private network, including after a redirect. Opt in with `BROADSIDE_ALLOW_PRIVATE_FETCH=1` for local targets.

Feeds are text from someone else's server, and are treated that way. A feed is fetched through the same guard, with a 2 MB cap applied after decompression and a 15 second timeout. The XML reader is Broadside's own and does only what feeds need: it never processes a document type, so a feed that declares entities (the route to entity expansion and to reading local files or internal addresses) is refused whole, and one that only names a public DTD has it skipped and never fetched. Only the five XML entities and numeric references are decoded, once. Depth, element count and items read are capped. Titles and summaries are reduced to plain text and stored and shown as text; nothing from a feed is rendered as HTML, and a link is kept only if it is an http or https address. Placeholders are filled in one pass, so an item cannot smuggle a placeholder into its own text.

Outgoing webhooks send your posts to an address, so they are made by a person, in the app or over REST with a key, and never by an agent. Each has its own signing secret, sealed at rest like credentials, returned once and never again; the delivery log keeps the receiver's status code and nothing else it said. A delivery goes to the address you typed and nowhere else: a redirect is never followed, so the signed body cannot be sent on to another host. A payload is the post as the API returns it and contains no credentials. In a team it carries the name of the member who wrote the post.

Signing in with a network starts from the app or from an API key, never from another site. A pending sign-in is one encrypted row that works once and is gone after ten minutes, and the callback connects nothing for a state value this Broadside did not issue. Where the network supports PKCE (X, TikTok) it is used. The app's secret is sent to the network in a request body or a Basic header, never in an address. Only what posting needs is kept afterwards: for Facebook, Instagram and Threads that is one token, and the app's secret is discarded. A choice of Pages or boards waits in a second row of the same kind, and the browser is shown names, never tokens.

Agents see text that other people control: account names, error messages from networks, links, and the titles and text that come from feeds. The MCP server tells agents to treat those as data. A draft made from a feed can be edited by an agent and published only by a person, whatever the mode. If you would rather an agent could never publish on its own, set `BROADSIDE_MCP_DRAFTS_ONLY=1`.

Known limits:

- API keys do not expire. Revoke one under Connect when you stop using it. Without a team a key has no limits: it can add feeds and outgoing webhooks over REST, so an agent that holds a key and can run commands is not kept from them by the MCP tool list alone. In a team, give an agent a key with the lowest role that does its job.
- Roles do not bind someone with a shell on the server. Whoever can read the data folder can run `npm run members`, start the stdio server or open the database.
- Sign-in attempts are slowed per member name and for everyone, never per client: Broadside cannot see a client address it could trust, so one person guessing hard at a name makes that member's own sign-in take a few seconds longer.
- A viewer reads everything in the app, drafts and scheduled posts included. There are no private posts and no per-account permissions: an editor can post to every connected account.
- An invite link works for whoever opens it first. Send it somewhere private, and revoke it if it went astray.
- A post records who created it, and nothing records who later edited or published it.
- A feed set to publish sends out whatever its source says, including mentions and links, with no one reading it first. Draft is the default for that reason.
- An agent that reads a feed's draft could still copy its text into a post of its own. The rule stops it publishing the draft; it does not make feed text safe to act on.
- The address of an outgoing webhook is stored as typed and shown in the app and over REST. If your receiver's address contains a token, anyone who can open Broadside can read it. The signing secret is what a receiver should trust.
- The private-address check resolves a name before connecting to it, so a hostile DNS server that changes its answer between the two could still get through. It narrows that hole and does not close it.
- A few networks (Threads, Instagram, Facebook) take the access token in the URL, as their APIs require.
- An upload is held in memory while it is checked, so the size limit is also a memory limit.
- There is no audit log yet beyond the post history.

To put Broadside on the internet, keep it on `127.0.0.1` and publish it through a tunnel with an access layer in front (Cloudflare Tunnel with an Access application, for example), allowing `/media/*` through so networks can fetch your media, and keep `BROADSIDE_PASSWORD` set as well. This layout is the recommendation from a security review of the code; the exact tunnel settings were not tested here.

## How it is built

- `src/lib/platforms/` holds one connector per network: its credential fields, limits and the HTTP calls that publish. Connectors never touch the database, so each is tested with a fake `fetch`.
- `src/lib/posts.ts` is the engine: validate, fan out, record a status per target, retry transient failures. A target is claimed with a compare-and-set before it is sent, so two clocks can never post it twice, and a target interrupted mid-send is failed rather than resent. A thread is recorded part by part, so a retry continues where it stopped, and the next occurrence of a repeating post is created under the same kind of claim, exactly once.
- `src/lib/oauth.ts` is the sign-in every network shares. Each connector describes its own network in an `oauth` block: where to approve, the scopes, the style of PKCE, how the code is exchanged and what is stored. `src/lib/platforms/oauth2.ts` renews tokens before a post and hands rotated ones back to be saved.
- `src/lib/tags.ts`, `src/lib/groups.ts` and `src/lib/signatures.ts` hold tags, account groups and signatures. Their tables are created by the same additive migration as every column added since the first release, so an existing database gains them and keeps its data.
- `src/lib/analytics.ts` reads numbers back. A connector's optional `metrics` function asks its network for one post's counts and returns only what the network answered, each under the network's own word. Every reading is stored with its time, and numbers that repeat the reading before move that time on instead of adding a row; a failed one leaves the last good row in place and records the reason. A target is claimed with a compare-and-set before it is read, so two clocks never ask twice, and a 429 pauses that account until the network's wait is over. The scheduler runs this beside publishing and waits for neither.
- `src/lib/outgoing.ts` holds outgoing webhooks. The engine queues one row per webhook when something happens and does nothing else, so it never waits for a receiver; the scheduler sends what is queued, signs each try afresh, retries with a growing wait and pauses a webhook that keeps failing. A delivery is claimed with a compare-and-set before it is sent.
- `src/lib/feeds.ts` reads feeds and `src/lib/feed-parse.ts` is the XML reader, written from the RSS and Atom specifications with no parser dependency. An item is remembered before its post is made, so a crash between the two skips the item and can never post it twice.
- `src/lib/mcp.ts` defines the tools once; `/mcp` (HTTP) and `bin/broadside-mcp.ts` (stdio) both serve them. Every tool is registered through one check against `TOOL_ROLES`, and a tool with no role in that table cannot be registered.
- `src/lib/members.ts` holds the team: members, password hashing, invites and the rules for who may change whom. `src/lib/actor.ts` answers one question for every request, who is asking and with what role, from the database each time. `src/lib/http.ts` wraps every route: `route({ role }, handler)` checks the caller against the role the route declares and hands the handler that actor, and `open("why", handler)` marks the few routes meant for anyone. `scripts/check-routes.mjs` fails for a route file that uses neither.
- `src/lib/scheduler.ts` is an in-process clock started with the server.

Adding a network is one object that implements `Connector` in `src/lib/platforms/types.ts`, plus a line in the registry and a request-shape test. Give it a `reply` function if the network can answer its own post, and it takes threads. Give it `metrics` and `reports` if the network's API gives an account its own post's counts, or `noMetrics` with the reason if it does not.

## Design

Dark, after Resend's site: a black ground, a serif display face (Instrument Serif) with a lit fill over Geist, hairline glass cards with light on their top edge, and one red as the signal colour. No fonts, renders or code come from Resend.

Borrowed, with thanks:

- The hero turntable is the Carousel block from [bencho.dev](https://bencho.dev) (MIT), adapted to hold a card per network. Only Bencho blocks under its MIT licence are used; its Pro blocks may not be redistributed, so none are in this repository.
- Network logos come from the CC0 [Simple Icons](https://simpleicons.org) set and belong to their owners. LinkedIn, Slack and Nostr are not in that set, so they show initials.

## Licence

MIT. There are no paid plans, and no service sits between you and the networks.
