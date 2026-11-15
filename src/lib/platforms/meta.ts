import { blob, call, counted, images, videos, PublishError, withHint, type Choice, type Connector, type Context, type MediaItem, type OAuthSpec, type Reports, type TokenResponse } from "./types";

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

/** Meta's insights answer one entry per metric, each with a lifetime value. A metric Meta left out is left out here. */
type Insights = { data?: { name: string; values?: { value?: unknown }[] }[] };
const insight = (found: Insights, name: string): unknown => found.data?.find((entry) => entry.name === name)?.values?.[0]?.value;

/* Threads ----------------------------------------------------------------- */

/** Threads also reports shares, which it still marks as in development; they are not read. */
const threadsReports: Reports = { views: "Views", likes: "Likes", comments: "Replies", shares: "Reposts", quotes: "Quotes" };

const TH = "https://graph.threads.net/v1.0";

/**
 * The code is exchanged for a token that lasts about an hour, and that one is
 * traded at once for a long-lived token (60 days), which is the only thing
 * stored. Publishing refreshes it, so the app's secret is not kept.
 *
 * Meta documents the long-lived exchange as a GET with the secret in the
 * query string. It is sent as a POST with the same parameters in the body,
 * which the endpoint reads the same way, so the secret stays out of the address.
 */
const threadsOAuth: OAuthSpec = {
  authorizeUrl: "https://threads.com/oauth/authorize",
  tokenUrl: "https://graph.threads.com/oauth/access_token",
  // threads_manage_replies is what lets a thread's later parts go out as replies; threads_manage_insights is what lets a post's numbers be read.
  scopes: ["threads_basic", "threads_content_publish", "threads_manage_replies", "threads_manage_insights"],
  scopeSeparator: ",",
  client: { id: "app_id", secret: "app_secret" },
  pkce: "none",
  clientAuth: "body",
  httpsOnly: true,
  async exchange(tokens, app, ctx) {
    const long = await call<TokenResponse>(ctx, "Threads", "https://graph.threads.com/access_token", form({ grant_type: "th_exchange_token", client_secret: app.app_secret, access_token: tokens.access_token }));
    if (!long.access_token) throw new PublishError("Threads did not return a long-lived token.");
    return { access_token: long.access_token };
  },
  paste: {
    required: ["access_token"],
    help: "In the Threads use case's settings, open the User token generator and generate a token for your account. To post threads it also needs threads_manage_replies, and to read a post's numbers threads_manage_insights.",
  },
};

export const threads: Connector = {
  id: "threads",
  name: "Threads",
  docsUrl: "https://developers.facebook.com/docs/threads/get-started",
  setup: [
    "Create a Meta app with the Threads use case, with the permissions threads_basic, threads_content_publish, threads_manage_replies and threads_manage_insights, and add your account as a Threads tester.",
    "threads_manage_insights is what lets Broadside read a post's views, likes, replies, reposts and quotes. Without it posts still go out and their numbers are not read.",
    "In the use case's settings, add the redirect address shown below under valid OAuth redirect URIs. Threads accepts only https addresses there, so signing in needs Broadside on an https address (set BROADSIDE_PUBLIC_URL).",
    "Paste the Threads app ID and Threads app secret from the same page, then continue to Threads and approve.",
    "On http://localhost, paste a token from the User token generator. Either way the token lasts 60 days and Broadside refreshes it each time it posts.",
  ],
  fields: [
    { key: "app_id", label: "Threads app ID", kind: "text", optional: true },
    { key: "app_secret", label: "Threads app secret", kind: "secret", optional: true },
    { key: "access_token", label: "Access token", kind: "secret", hidden: true },
  ],
  oauth: threadsOAuth,
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

  async reply(input, c, ctx) {
    const token = c.access_token;
    const made = await call<{ id: string }>(
      ctx,
      "Threads",
      `${TH}/${c.user_id}/threads`,
      form({ media_type: "TEXT", text: input.text, reply_to_id: input.parent.id, access_token: token }),
    );
    const published = await call<{ id: string }>(ctx, "Threads", `${TH}/${c.user_id}/threads_publish`, form({ creation_id: made.id, access_token: token }));
    const link = await call<{ permalink?: string }>(
      ctx,
      "Threads",
      `${TH}/${published.id}?fields=permalink&access_token=${encodeURIComponent(token)}`,
    ).catch(() => ({ permalink: undefined }));
    return { id: published.id, url: link.permalink };
  },

  reports: threadsReports,
  async metrics(input, c, ctx) {
    const found = await call<Insights>(
      ctx,
      "Threads",
      `${TH}/${encodeURIComponent(input.id)}/insights?metric=views,likes,replies,reposts,quotes&access_token=${encodeURIComponent(c.access_token)}`,
    ).catch((error) => withHint(error, "Reading numbers needs the permission threads_manage_insights. If this account was connected without it, reconnect it."));
    return {
      metrics: counted(threadsReports, { views: insight(found, "views"), likes: insight(found, "likes"), comments: insight(found, "replies"), shares: insight(found, "reposts"), quotes: insight(found, "quotes") }),
    };
  },
};

/* Facebook Page ----------------------------------------------------------- */

const FB = "https://graph.facebook.com";
/** The Graph API version the sign-in addresses name, as Meta's Facebook Login guide writes them. */
const GRAPH = "v27.0";

/** One Facebook Page the signed-in person manages, with the token that posts as it. */
type Page = { id: string; name: string; access_token?: string };

/**
 * Facebook Login, shared by Pages and Instagram. The code buys a user token
 * that lasts an hour or two; trading it for a long-lived one first is what
 * makes the Page tokens read with it never expire. Only a Page token is
 * stored with an account. The user token and the app's secret are not.
 *
 * Meta's guide writes both exchanges as GETs with the secret in the query
 * string. They are sent as POSTs with the same parameters in the body, which
 * the endpoint reads the same way, so the secret stays out of the address.
 */
const facebookLogin = (scopes: string[]): Pick<OAuthSpec, "authorizeUrl" | "tokenUrl" | "scopes" | "scopeSeparator" | "client" | "pkce" | "clientAuth" | "loopback" | "exchange"> => ({
  authorizeUrl: `https://www.facebook.com/${GRAPH}/dialog/oauth`,
  tokenUrl: `${FB}/${GRAPH}/oauth/access_token`,
  scopes,
  scopeSeparator: ",",
  client: { id: "app_id", secret: "app_secret" },
  pkce: "none",
  clientAuth: "body",
  // An app in development mode may redirect to http://localhost, and to nothing else that is not https.
  loopback: "localhost",
  async exchange(tokens, app, ctx) {
    const long = await call<TokenResponse>(
      ctx,
      "Facebook",
      `${FB}/${GRAPH}/oauth/access_token`,
      form({ grant_type: "fb_exchange_token", client_id: app.app_id, client_secret: app.app_secret, fb_exchange_token: tokens.access_token }),
    );
    if (!long.access_token) throw new PublishError("Facebook did not return a long-lived token.");
    return { user_token: long.access_token };
  },
});

/** Every Page the signed-in person can act for, following Facebook's paging to the end. */
async function pages(userToken: string, ctx: Context): Promise<Page[]> {
  const found: Page[] = [];
  let url: string | undefined = `${FB}/${GRAPH}/me/accounts?fields=id,name,access_token&limit=100&access_token=${encodeURIComponent(userToken)}`;
  for (let page = 0; url && page < 10; page++) {
    const batch: { data?: Page[]; paging?: { next?: string } } = await call(ctx, "Facebook", url);
    found.push(...(batch.data ?? []));
    // The next page is followed only while it stays on Facebook's own host, since the address comes from the response.
    url = batch.paging?.next?.startsWith(`${FB}/`) ? batch.paging.next : undefined;
  }
  return found.filter((page) => page.access_token);
}

/** Reactions of every type are counted together, as Facebook's own total does. */
const facebookReports: Reports = { views: "Views", likes: "Reactions", comments: "Comments", shares: "Shares", clicks: "Clicks" };

export const facebook: Connector = {
  id: "facebook",
  name: "Facebook Page",
  docsUrl: "https://developers.facebook.com/docs/pages-api/posts",
  setup: [
    "Create a Meta app with Facebook Login, and keep it in development mode unless Meta has reviewed it. In development mode it works for people with a role on the app.",
    "In Facebook Login settings add the redirect address shown below under Valid OAuth Redirect URIs. An address on http://localhost needs no entry while the app is in development mode.",
    "Paste the App ID and App secret from App settings, Basic, then continue to Facebook, approve, and pick the Pages to connect.",
    "A Page stays connected: the Page token Broadside keeps does not expire.",
    "read_insights is what lets Broadside read a post's views and clicks. Reactions, comments and shares are read with pages_read_engagement.",
  ],
  fields: [
    { key: "app_id", label: "App ID", kind: "text", optional: true },
    { key: "app_secret", label: "App secret", kind: "secret", optional: true },
    { key: "page_id", label: "Page id", kind: "text", hidden: true },
    { key: "access_token", label: "Page access token", kind: "secret", hidden: true },
  ],
  oauth: {
    // pages_manage_engagement is what lets a thread's later parts go out as comments; read_insights is what lets a post's views and clicks be read.
    ...facebookLogin(["pages_show_list", "pages_manage_posts", "pages_read_engagement", "pages_manage_engagement", "read_insights"]),
    choose: {
      prompt: "Pick the Pages to connect. Each becomes its own account.",
      multiple: true,
      empty: "Facebook listed no Pages for this sign-in. Approve at least one Page on Facebook's screen, and check that you manage it.",
      async list(c, ctx) {
        return (await pages(c.user_token, ctx)).map((page): Choice => ({ id: page.id, name: page.name, credentials: { page_id: page.id, access_token: page.access_token! } }));
      },
    },
    paste: {
      required: ["page_id", "access_token"],
      help: "In the Graph API Explorer request pages_manage_posts, pages_read_engagement, pages_manage_engagement and read_insights, exchange for a long-lived user token, and read the Page's id and Page access token from /me/accounts.",
    },
  },
  limits: { maxChars: 63206, count: "graphemes", maxImages: 10, maxVideos: 0, requiresMedia: false, maxReplyChars: 8000 },

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

  // Each later part is a comment on the post itself: Facebook nests comments one level deep, so a chain of replies would not hold.
  async reply(input, c, ctx) {
    const comment = await call<{ id: string }>(ctx, "Facebook", `${FB}/${input.root.id}/comments`, form({ message: input.text, access_token: c.access_token }));
    return { id: comment.id };
  },

  reports: facebookReports,
  async metrics(input, c, ctx) {
    const token = encodeURIComponent(c.access_token);
    const id = encodeURIComponent(input.id);
    // The totals of the post's reactions and comments, without the lists of who made them.
    const post = await call<{ shares?: { count?: number }; reactions?: { summary?: { total_count?: number } }; comments?: { summary?: { total_count?: number } } }>(
      ctx,
      "Facebook",
      `${FB}/${id}?fields=shares,reactions.summary(total_count).limit(0),comments.summary(true).limit(0)&access_token=${token}`,
    );
    // Facebook leaves `shares` out of a post nobody has shared.
    const engagement = { likes: post.reactions?.summary?.total_count, comments: post.comments?.summary?.total_count, shares: post.shares?.count ?? 0 };
    try {
      const found = await call<Insights>(ctx, "Facebook", `${FB}/${id}/insights?metric=post_media_view,post_clicks&access_token=${token}`);
      return { metrics: counted(facebookReports, { ...engagement, views: insight(found, "post_media_view"), clicks: insight(found, "post_clicks") }) };
    } catch (error) {
      // Insights sit behind their own permission. A Page connected without it still has its reactions, comments and shares.
      if (!(error instanceof PublishError) || (error.status !== 400 && error.status !== 403)) throw error;
      return {
        metrics: counted(facebookReports, engagement),
        note: `Views and clicks were not read. ${error.message} They need the permission read_insights. If this Page was connected without it, reconnect it.`,
      };
    }
  },
};

/* Instagram --------------------------------------------------------------- */

const instagramReports: Reports = { views: "Views", likes: "Likes", comments: "Comments", shares: "Shares", saves: "Saves" };

export const instagram: Connector = {
  id: "instagram",
  name: "Instagram",
  docsUrl: "https://developers.facebook.com/docs/instagram-platform/content-publishing",
  setup: [
    "Switch the Instagram account to Professional (Business or Creator) and link it to a Facebook Page you manage.",
    "Create a Meta app with Facebook Login and the Instagram permissions, and keep it in development mode unless Meta has reviewed it.",
    "In Facebook Login settings add the redirect address shown below under Valid OAuth Redirect URIs. An address on http://localhost needs no entry while the app is in development mode.",
    "Paste the App ID and App secret from App settings, Basic, then continue to Facebook, approve, and pick the Instagram accounts to connect.",
    "instagram_manage_insights is what lets Broadside read a post's views, likes, comments, shares and saves. Instagram can take up to 48 hours to report them.",
  ],
  fields: [
    { key: "app_id", label: "App ID", kind: "text", optional: true },
    { key: "app_secret", label: "App secret", kind: "secret", optional: true },
    { key: "ig_user_id", label: "Instagram account id", kind: "text", hidden: true },
    { key: "access_token", label: "Access token", kind: "secret", hidden: true },
  ],
  oauth: {
    // instagram_manage_comments is what lets a thread's later parts go out as comments, and instagram_manage_insights what lets a post's numbers be read. The Page permissions are how Facebook finds the account.
    ...facebookLogin(["instagram_basic", "instagram_content_publish", "instagram_manage_comments", "instagram_manage_insights", "pages_show_list", "pages_read_engagement"]),
    choose: {
      prompt: "Pick the Instagram accounts to connect. Each becomes its own account.",
      multiple: true,
      empty: "Facebook listed no Instagram professional account for this sign-in. Link the Instagram account to a Facebook Page you manage, and approve that Page on Facebook's screen.",
      async list(c, ctx) {
        const choices: Choice[] = [];
        for (const page of await pages(c.user_token, ctx)) {
          const linked = await call<{ instagram_business_account?: { id: string; username?: string } }>(
            ctx,
            "Instagram",
            `${FB}/${GRAPH}/${page.id}?fields=instagram_business_account{id,username}&access_token=${encodeURIComponent(page.access_token!)}`,
          );
          const account = linked.instagram_business_account;
          // Publishing uses the token of the Page the account is linked to.
          if (account) choices.push({ id: account.id, name: account.username ? `@${account.username}` : `Instagram account ${account.id}`, detail: `Linked to the Page ${page.name}`, credentials: { ig_user_id: account.id, access_token: page.access_token! } });
        }
        return choices;
      },
    },
    paste: {
      required: ["ig_user_id", "access_token"],
      help: "Request instagram_basic, instagram_content_publish, instagram_manage_comments and instagram_manage_insights for someone who manages the linked Page. The account id is in /{page-id}?fields=instagram_business_account.",
    },
  },
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

  // Each later part is a comment on the media: Instagram has no reply chain for an account's own posts.
  async reply(input, c, ctx) {
    const comment = await call<{ id: string }>(ctx, "Instagram", `${FB}/${input.root.id}/comments`, form({ message: input.text, access_token: c.access_token }));
    return { id: comment.id };
  },

  reports: instagramReports,
  async metrics(input, c, ctx) {
    const found = await call<Insights>(
      ctx,
      "Instagram",
      `${FB}/${encodeURIComponent(input.id)}/insights?metric=views,likes,comments,shares,saved&access_token=${encodeURIComponent(c.access_token)}`,
    ).catch((error) => withHint(error, "Reading numbers needs the permission instagram_manage_insights. If this account was connected without it, reconnect it."));
    return {
      metrics: counted(instagramReports, { views: insight(found, "views"), likes: insight(found, "likes"), comments: insight(found, "comments"), shares: insight(found, "shares"), saves: insight(found, "saved") }),
    };
  },
};
