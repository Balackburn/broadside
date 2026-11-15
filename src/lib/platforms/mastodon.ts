import { blob, call, type Connector, type Credentials } from "./types";

const base = (c: Credentials) => c.instance.replace(/\/+$/, "");
const auth = (c: Credentials) => ({ authorization: `Bearer ${c.access_token}` });

export const mastodon: Connector = {
  id: "mastodon",
  name: "Mastodon",
  docsUrl: "https://docs.joinmastodon.org/client/token/",
  setup: [
    "On your instance open Preferences, Development, New application.",
    "Tick the scopes read:accounts, write:statuses and write:media, save, and copy the access token.",
  ],
  fields: [
    { key: "instance", label: "Instance URL", kind: "url", placeholder: "https://mastodon.social" },
    { key: "access_token", label: "Access token", kind: "secret" },
  ],
  options: [
    { key: "visibility", label: "Visibility", kind: "select", choices: ["public", "unlisted", "private"] },
    { key: "spoiler_text", label: "Content warning", kind: "text" },
  ],
  limits: { maxChars: 500, count: "graphemes", maxImages: 4, maxVideos: 1, requiresMedia: false },

  async verify(c, ctx) {
    const me = await call<{ acct: string; avatar?: string }>(
      ctx,
      "Mastodon",
      `${base(c)}/api/v1/accounts/verify_credentials`,
      { headers: auth(c) },
    );
    return { handle: `@${me.acct}@${new URL(base(c)).host}`, avatarUrl: me.avatar };
  },

  async publish(input, c, ctx) {
    const mediaIds: string[] = [];
    for (const item of input.media) {
      const form = new FormData();
      form.set("file", blob(await item.read(), item.contentType), item.filename);
      if (item.alt) form.set("description", item.alt);
      const uploaded = await call<{ id: string }>(ctx, "Mastodon", `${base(c)}/api/v2/media`, {
        method: "POST",
        headers: auth(c),
        body: form,
      });
      mediaIds.push(uploaded.id);
    }
    const status = await call<{ id: string; url: string }>(ctx, "Mastodon", `${base(c)}/api/v1/statuses`, {
      method: "POST",
      headers: { ...auth(c), "content-type": "application/json" },
      body: JSON.stringify({
        status: input.text,
        media_ids: mediaIds,
        visibility: input.options.visibility ?? "public",
        spoiler_text: input.options.spoiler_text || undefined,
      }),
    });
    return { id: status.id, url: status.url };
  },

  async reply(input, c, ctx) {
    const status = await call<{ id: string; url: string }>(ctx, "Mastodon", `${base(c)}/api/v1/statuses`, {
      method: "POST",
      headers: { ...auth(c), "content-type": "application/json" },
      body: JSON.stringify({
        status: input.text,
        in_reply_to_id: input.parent.id,
        visibility: input.options.visibility ?? "public",
        spoiler_text: input.options.spoiler_text || undefined,
      }),
    });
    return { id: status.id, url: status.url };
  },
};
