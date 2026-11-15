import { blob, call, images, videos, PublishError, type Connector, type Context, type MediaItem } from "./types";

const form = (params: Record<string, string | undefined>): RequestInit => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, v);
  return { method: "POST", body };
};

const needUrl = (network: string, item: MediaItem): string => {
  if (!item.publicUrl) {
    throw new PublishError(
      `${network} fetches media from a public URL. Set BROADSIDE_PUBLIC_URL to an address the internet can reach, or attach media by URL.`,
    );
  }
  return item.publicUrl;
};

/** Containers on Meta's APIs are processed asynchronously; wait until one is ready before publishing it. */
async function ready(ctx: Context, network: string, url: string, field: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const state = await call<Record<string, string>>(ctx, network, url);
    const value = state[field];
    if (value === "FINISHED" || value === "PUBLISHED") return;
    if (value === "ERROR" || value === "EXPIRED") {
      throw new PublishError(`${network} could not process the media: ${state.error_message ?? value}`);
    }
    await new Promise((r) => setTimeout(r, Number(process.env.BROADSIDE_POLL_MS ?? 3000)));
  }
  throw new PublishError(`${network} was still processing the media after two minutes.`, true);
}

/* Threads ----------------------------------------------------------------- */

const TH = "https://graph.threads.net/v1.0";

export const threads: Connector = {
  id: "threads",
  name: "Threads",
  docsUrl: "https://developers.facebook.com/docs/threads/get-started",
  setup: [
    "Create a Meta app with the Threads use case and add your account as a Threads tester.",
    "In the use case's settings open the User token generator and generate a token for your account.",
    "Paste that long-lived token here. It lasts 60 days; Broadside refreshes it each time it posts.",
  ],
  fields: [{ key: "access_token", label: "Access token", kind: "secret" }],
  limits: { maxChars: 500, count: "graphemes", maxImages: 10, maxVideos: 1, requiresMedia: false, pullsMedia: true },

  async verify(c, ctx) {
    const me = await call<{ id: string; username: string; threads_profile_picture_url?: string }>(
      ctx,
      "Threads",
      `${TH}/me?fields=id,username,threads_profile_picture_url&access_token=${encodeURIComponent(c.access_token)}`,
    );
    return { handle: `@${me.username}`, avatarUrl: me.threads_profile_picture_url, credentials: { user_id: me.id } };
  },

  async publish(input, c, ctx) {
    const token = c.access_token;
    const container = async (params: Record<string, string | undefined>) => {
      const made = await call<{ id: string }>(ctx, "Threads", `${TH}/${c.user_id}/threads`, form({ ...params, access_token: token }));
      if (params.media_type !== "TEXT") {
        await ready(ctx, "Threads", `${TH}/${made.id}?fields=status,error_message&access_token=${encodeURIComponent(token)}`, "status");
      }
      return made.id;
    };
    const media = (item: MediaItem) =>
      item.type === "video"
        ? { media_type: "VIDEO", video_url: needUrl("Threads", item) }
        : { media_type: "IMAGE", image_url: needUrl("Threads", item), alt_text: item.alt };

    let creation: string;
    if (input.media.length === 0) creation = await container({ media_type: "TEXT", text: input.text });
    else if (input.media.length === 1) creation = await container({ ...media(input.media[0]), text: input.text });
    else {
      const children = [];
      for (const item of input.media) children.push(await container({ ...media(item), is_carousel_item: "true" }));
      creation = await container({ media_type: "CAROUSEL", children: children.join(","), text: input.text });
    }
    const published = await call<{ id: string }>(
      ctx,
      "Threads",
      `${TH}/${c.user_id}/threads_publish`,
      form({ creation_id: creation, access_token: token }),
    );
    const link = await call<{ permalink?: string }>(
      ctx,
      "Threads",
      `${TH}/${published.id}?fields=permalink&access_token=${encodeURIComponent(token)}`,
    ).catch(() => ({ permalink: undefined }));
    // Long-lived tokens last 60 days; refreshing on use keeps the account connected.
    const fresh = await call<{ access_token?: string }>(
      ctx,
      "Threads",
      `https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(token)}`,
    ).catch(() => ({ access_token: undefined }));
    return {
      id: published.id,
      url: link.permalink,
      credentials: fresh.access_token ? { ...c, access_token: fresh.access_token } : undefined,
    };
  },
};

/* Facebook Page ----------------------------------------------------------- */

const FB = "https://graph.facebook.com";

export const facebook: Connector = {
  id: "facebook",
  name: "Facebook Page",
  docsUrl: "https://developers.facebook.com/docs/pages-api/posts",
  setup: [
    "Create a Meta app, then in the Graph API Explorer request pages_manage_posts and pages_read_engagement.",
    "Exchange for a long-lived user token and call /me/accounts to read your Page's id and Page access token.",
    "Paste the Page id and its Page access token here. A Page token made from a long-lived user token does not expire.",
  ],
  fields: [
    { key: "page_id", label: "Page id", kind: "text" },
    { key: "access_token", label: "Page access token", kind: "secret" },
  ],
  limits: { maxChars: 63206, count: "graphemes", maxImages: 10, maxVideos: 0, requiresMedia: false },

  async verify(c, ctx) {
    const page = await call<{ name: string; picture?: { data?: { url?: string } } }>(
      ctx,
      "Facebook",
      `${FB}/${c.page_id}?fields=name,picture&access_token=${encodeURIComponent(c.access_token)}`,
    );
    return { handle: page.name, avatarUrl: page.picture?.data?.url };
  },

  async publish(input, c, ctx) {
    if (videos(input).length) throw new PublishError("Video on Facebook Pages is not supported yet.");
    const attached: string[] = [];
    for (const image of images(input)) {
      const body = new FormData();
      body.set("source", blob(await image.read(), image.contentType), image.filename);
      body.set("published", "false");
      body.set("access_token", c.access_token);
      const photo = await call<{ id: string }>(ctx, "Facebook", `${FB}/${c.page_id}/photos`, { method: "POST", body });
      attached.push(photo.id);
    }
    const params: Record<string, string> = { message: input.text, access_token: c.access_token };
    attached.forEach((id, i) => (params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id })));
    const post = await call<{ id: string; permalink_url?: string }>(
      ctx,
      "Facebook",
      `${FB}/${c.page_id}/feed?fields=id,permalink_url`,
      form(params),
    );
    return { id: post.id, url: post.permalink_url ?? `https://www.facebook.com/${post.id}` };
  },
};

/* Instagram --------------------------------------------------------------- */

export const instagram: Connector = {
  id: "instagram",
  name: "Instagram",
  docsUrl: "https://developers.facebook.com/docs/instagram-platform/content-publishing",
  setup: [
    "Switch the account to Professional (Business or Creator) and link it to a Facebook Page.",
    "With a Meta app, request instagram_basic and instagram_content_publish for a user that manages that Page.",
    "Paste the Instagram account id (from /{page-id}?fields=instagram_business_account) and the access token.",
  ],
  fields: [
    { key: "ig_user_id", label: "Instagram account id", kind: "text" },
    { key: "access_token", label: "Access token", kind: "secret" },
  ],
  limits: { maxChars: 2200, count: "graphemes", maxImages: 10, maxVideos: 1, requiresMedia: true, pullsMedia: true },

  async verify(c, ctx) {
    const me = await call<{ username: string; profile_picture_url?: string }>(
      ctx,
      "Instagram",
      `${FB}/${c.ig_user_id}?fields=username,profile_picture_url&access_token=${encodeURIComponent(c.access_token)}`,
    );
    return { handle: `@${me.username}`, avatarUrl: me.profile_picture_url };
  },

  async publish(input, c, ctx) {
    const token = c.access_token;
    const container = async (params: Record<string, string | undefined>) => {
      const made = await call<{ id: string }>(ctx, "Instagram", `${FB}/${c.ig_user_id}/media`, form({ ...params, access_token: token }));
      await ready(ctx, "Instagram", `${FB}/${made.id}?fields=status_code&access_token=${encodeURIComponent(token)}`, "status_code");
      return made.id;
    };
    const one = (item: MediaItem, carousel: boolean) =>
      item.type === "video"
        ? { media_type: carousel ? "VIDEO" : "REELS", video_url: needUrl("Instagram", item) }
        : { image_url: needUrl("Instagram", item), alt_text: item.alt };

    let creation: string;
    if (input.media.length === 1) creation = await container({ ...one(input.media[0], false), caption: input.text });
    else {
      const children = [];
      for (const item of input.media) children.push(await container({ ...one(item, true), is_carousel_item: "true" }));
      creation = await container({ media_type: "CAROUSEL", children: children.join(","), caption: input.text });
    }
    const published = await call<{ id: string }>(
      ctx,
      "Instagram",
      `${FB}/${c.ig_user_id}/media_publish`,
      form({ creation_id: creation, access_token: token }),
    );
    const link = await call<{ permalink?: string }>(
      ctx,
      "Instagram",
      `${FB}/${published.id}?fields=permalink&access_token=${encodeURIComponent(token)}`,
    ).catch(() => ({ permalink: undefined }));
    return { id: published.id, url: link.permalink };
  },
};
