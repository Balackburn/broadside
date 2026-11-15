import { call, counted, images, json, PublishError, type Connector, type Context, type Credentials, type PartRef, type PublishResult, type Reports } from "./types";

type Session = { accessJwt: string; did: string; handle: string };

const pds = (c: Credentials) => (c.service || "https://bsky.social").replace(/\/+$/, "");

async function session(c: Credentials, ctx: Context): Promise<Session> {
  return call<Session>(
    ctx,
    "Bluesky",
    `${pds(c)}/xrpc/com.atproto.server.createSession`,
    json({ identifier: c.identifier, password: c.app_password }),
  );
}

/** Links and hashtags become facets; offsets are UTF-8 byte positions, as the protocol requires. */
export function facets(text: string) {
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  const found: { index: { byteStart: number; byteEnd: number }; features: unknown[] }[] = [];
  const add = (match: RegExpMatchArray, value: string, feature: unknown) => {
    const start = bytes(text.slice(0, match.index! + match[0].indexOf(value)));
    found.push({ index: { byteStart: start, byteEnd: start + bytes(value) }, features: [feature] });
  };
  for (const m of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
    const uri = m[0].replace(/[.,;:!?]+$/, "");
    add(m, uri, { $type: "app.bsky.richtext.facet#link", uri });
  }
  for (const m of text.matchAll(/(^|\s)#([\p{L}\p{N}_]+)/gu)) {
    add(m, `#${m[2]}`, { $type: "app.bsky.richtext.facet#tag", tag: m[2] });
  }
  return found;
}

/** The counts on a post view. Bluesky has no view count. */
const reports: Reports = { likes: "Likes", comments: "Replies", shares: "Reposts", quotes: "Quotes" };

export const bluesky: Connector = {
  id: "bluesky",
  name: "Bluesky",
  docsUrl: "https://bsky.app/settings/app-passwords",
  setup: [
    "Open Bluesky, then Settings, Privacy and security, App passwords.",
    "Create an app password named Broadside and paste it here with your handle.",
  ],
  fields: [
    { key: "identifier", label: "Handle", kind: "text", placeholder: "you.bsky.social" },
    { key: "app_password", label: "App password", kind: "secret", placeholder: "xxxx-xxxx-xxxx-xxxx" },
    { key: "service", label: "PDS URL", kind: "url", placeholder: "https://bsky.social", optional: true },
  ],
  limits: { maxChars: 300, count: "graphemes", maxImages: 4, maxVideos: 0, requiresMedia: false },

  async verify(c, ctx) {
    const s = await session(c, ctx);
    const profile = await call<{ avatar?: string }>(
      ctx,
      "Bluesky",
      `${pds(c)}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(s.did)}`,
      { headers: { authorization: `Bearer ${s.accessJwt}` } },
    ).catch(() => ({ avatar: undefined }));
    return { handle: s.handle, avatarUrl: profile.avatar };
  },

  async publish(input, c, ctx) {
    const s = await session(c, ctx);
    const auth = { authorization: `Bearer ${s.accessJwt}` };
    const uploaded = [];
    for (const image of images(input)) {
      const bytes = await image.read();
      if (bytes.length > 1_000_000) {
        throw new PublishError(`Bluesky accepts images up to 1 MB; ${image.filename} is larger.`);
      }
      const { blob } = await call<{ blob: unknown }>(ctx, "Bluesky", `${pds(c)}/xrpc/com.atproto.repo.uploadBlob`, {
        method: "POST",
        headers: { ...auth, "content-type": image.contentType },
        body: bytes as BodyInit,
      });
      uploaded.push({ alt: image.alt ?? "", image: blob });
    }
    const record: Record<string, unknown> = {
      $type: "app.bsky.feed.post",
      text: input.text,
      createdAt: new Date().toISOString(),
      facets: facets(input.text),
    };
    if (uploaded.length) record.embed = { $type: "app.bsky.embed.images", images: uploaded };
    return create(s, record, c, ctx);
  },

  async reply(input, c, ctx) {
    // A reply names both ends of the thread by uri and cid, so a part published without a cid cannot be answered.
    const strong = (part: PartRef) => {
      if (!part.ref?.cid) throw new PublishError("Bluesky did not return a cid for the earlier part, which a reply must quote.");
      return { uri: part.id, cid: part.ref.cid };
    };
    const reply = { root: strong(input.root), parent: strong(input.parent) };
    const s = await session(c, ctx);
    return create(s, { $type: "app.bsky.feed.post", text: input.text, createdAt: new Date().toISOString(), facets: facets(input.text), reply }, c, ctx);
  },

  reports,
  async metrics(input, c, ctx) {
    const s = await session(c, ctx);
    // Asked of the account's own server, which passes app.bsky requests on to the app view as the signed-in account.
    const found = await call<{ posts?: { uri: string; likeCount?: number; replyCount?: number; repostCount?: number; quoteCount?: number }[] }>(
      ctx,
      "Bluesky",
      `${pds(c)}/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(input.id)}`,
      { headers: { authorization: `Bearer ${s.accessJwt}` } },
    );
    const post = found.posts?.find((p) => p.uri === input.id);
    if (!post) throw new PublishError("Bluesky returned no post for this address. It may have been deleted.");
    return { metrics: counted(reports, { likes: post.likeCount, comments: post.replyCount, shares: post.repostCount, quotes: post.quoteCount }) };
  },
};

async function create(s: Session, record: Record<string, unknown>, c: Credentials, ctx: Context): Promise<PublishResult> {
  const created = await call<{ uri: string; cid?: string }>(
    ctx,
    "Bluesky",
    `${pds(c)}/xrpc/com.atproto.repo.createRecord`,
    json({ repo: s.did, collection: "app.bsky.feed.post", record }, { authorization: `Bearer ${s.accessJwt}` }),
  );
  const rkey = created.uri.split("/").pop();
  return { id: created.uri, url: `https://bsky.app/profile/${s.handle}/post/${rkey}`, ref: created.cid ? { cid: created.cid } : undefined };
}
