import { tokenFields, withSession } from "./oauth2";
import { call, images, videos, PublishError, type Connector, type Context, type Credentials, type OAuthSpec } from "./types";

const REST = "https://api.linkedin.com/rest";

/**
 * LinkedIn versions its API by month and retires each version after a year.
 * Two months back is always a released, supported version.
 */
export function apiVersion(today = new Date()): string {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 2, 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const headers = (c: Credentials) => ({
  authorization: `Bearer ${c.access_token}`,
  "linkedin-version": process.env.BROADSIDE_LINKEDIN_VERSION || apiVersion(),
  "x-restli-protocol-version": "2.0.0",
  "content-type": "application/json",
});

/** `commentary` is "little text": these characters are syntax and must be escaped to appear literally. */
export const escapeLittleText = (text: string): string => text.replace(/[\\|{}@[\]()<>#*_~]/g, (ch) => `\\${ch}`);

async function send(ctx: Context, url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await ctx.fetch(url, init);
  } catch (cause) {
    throw new PublishError(`LinkedIn could not be reached: ${(cause as Error).message}`, true);
  }
  if (!response.ok) {
    const detail = await response.text();
    let message = detail.slice(0, 300);
    try {
      message = JSON.parse(detail).message ?? message;
    } catch {
      /* keep text */
    }
    throw new PublishError(`LinkedIn answered ${response.status}: ${message}`, response.status === 429 || response.status >= 500);
  }
  return response;
}

/**
 * LinkedIn's access tokens last 60 days. Most apps get no refresh token: only
 * apps LinkedIn has approved for its Marketing Developer Platform do, and
 * theirs lasts a year. Where one came back it is kept, with the app's id and
 * secret, and used when the access token runs out. Where none did, the app's
 * secret is not kept at all.
 */
const oauth: OAuthSpec = {
  authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
  tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
  // w_member_social covers posts and the comments a thread goes out as.
  scopes: ["openid", "profile", "w_member_social"],
  extraScopes: (app) => (app.organization_id ? ["w_organization_social"] : []),
  client: { id: "client_id", secret: "client_secret" },
  pkce: "none",
  clientAuth: "body",
  async exchange(tokens, app) {
    const kept: Credentials = tokenFields(tokens);
    if (app.organization_id) kept.organization_id = app.organization_id;
    return tokens.refresh_token ? { ...kept, client_id: app.client_id, client_secret: app.client_secret } : kept;
  },
  paste: {
    required: ["access_token"],
    optional: ["organization_id"],
    help: "Open the app's OAuth token generator, tick openid, profile and w_member_social, and generate a token. It lasts 60 days.",
  },
};

/** A token with a refresh token behind it is renewed when it runs out. One without is used until its 60 days are up. */
async function session<T extends object>(c: Credentials, ctx: Context, work: (live: Credentials) => Promise<T>): Promise<T> {
  if (c.refresh_token) return withSession("LinkedIn", oauth, c, ctx, work);
  if (c.expires_at && Date.parse(c.expires_at) < Date.now()) {
    const expired = new PublishError("The LinkedIn sign-in has run out. LinkedIn signs you in for 60 days at a time; reconnect the account.");
    expired.reconnect = true;
    throw expired;
  }
  return work(c);
}

export const linkedin: Connector = {
  id: "linkedin",
  name: "LinkedIn",
  docsUrl: "https://www.linkedin.com/developers/apps",
  setup: [
    "Create an app at linkedin.com/developers and add the products Share on LinkedIn and Sign In with LinkedIn using OpenID Connect.",
    "On the app's Auth tab, add the redirect address shown below under Authorized redirect URLs.",
    "Paste the Client ID and Client Secret from the same tab, then continue to LinkedIn and approve.",
    "LinkedIn signs you in for 60 days. Unless LinkedIn has approved your app for refresh tokens, reconnect here every two months.",
  ],
  fields: [
    { key: "client_id", label: "Client ID", kind: "text", optional: true },
    { key: "client_secret", label: "Client Secret", kind: "secret", optional: true },
    { key: "organization_id", label: "Company page id", kind: "text", optional: true, help: "Leave empty to post as yourself. Posting as a page needs w_organization_social, which LinkedIn grants with its Community Management API." },
    { key: "access_token", label: "Access token", kind: "secret", hidden: true },
    { key: "refresh_token", label: "Refresh token", kind: "secret", optional: true, hidden: true },
  ],
  oauth,
  limits: { maxChars: 3000, count: "graphemes", maxImages: 20, maxVideos: 0, requiresMedia: false, maxReplyChars: 1250 },

  async verify(c, ctx) {
    return session(c, ctx, async (live) => {
      const me = await call<{ sub: string; name: string; picture?: string }>(ctx, "LinkedIn", "https://api.linkedin.com/v2/userinfo", {
        headers: { authorization: `Bearer ${live.access_token}` },
      });
      const author = c.organization_id ? `urn:li:organization:${c.organization_id}` : `urn:li:person:${me.sub}`;
      return { handle: c.organization_id ? `Page ${c.organization_id}` : me.name, avatarUrl: me.picture, credentials: { author } };
    });
  },

  async publish(input, c, ctx) {
    if (videos(input).length) throw new PublishError("Video on LinkedIn is not supported yet.");
    return session(c, ctx, async (live) => {
      const uploaded: { id: string; altText: string }[] = [];
      for (const image of images(input)) {
        const init = await call<{ value: { uploadUrl: string; image: string } }>(ctx, "LinkedIn", `${REST}/images?action=initializeUpload`, {
          method: "POST",
          headers: headers(live),
          body: JSON.stringify({ initializeUploadRequest: { owner: c.author } }),
        });
        await send(ctx, init.value.uploadUrl, {
          method: "PUT",
          headers: { authorization: `Bearer ${live.access_token}`, "content-type": image.contentType },
          body: (await image.read()) as BodyInit,
        });
        uploaded.push({ id: init.value.image, altText: image.alt ?? "" });
      }
      const body: Record<string, unknown> = {
        author: c.author,
        commentary: escapeLittleText(input.text),
        visibility: "PUBLIC",
        distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      };
      if (uploaded.length === 1) body.content = { media: uploaded[0] };
      if (uploaded.length > 1) body.content = { multiImage: { images: uploaded } };
      const response = await send(ctx, `${REST}/posts`, { method: "POST", headers: headers(live), body: JSON.stringify(body) });
      const urn = response.headers.get("x-restli-id");
      if (!urn) throw new PublishError("LinkedIn accepted the post but returned no id.");
      return { id: urn, url: `https://www.linkedin.com/feed/update/${urn}/` };
    });
  },

  // Each later part is a first-level comment on the post. Comment text is plain, so it is not escaped the way commentary is.
  async reply(input, c, ctx) {
    return session(c, ctx, async (live) => {
      const post = input.root.id;
      const response = await send(ctx, `${REST}/socialActions/${encodeURIComponent(post)}/comments`, {
        method: "POST",
        headers: headers(live),
        body: JSON.stringify({ actor: c.author, object: post, message: { text: input.text } }),
      });
      const body = (await response.json().catch(() => ({}))) as { id?: string; commentUrn?: string };
      const id = body.commentUrn ?? body.id ?? response.headers.get("x-restli-id");
      if (!id) throw new PublishError("LinkedIn accepted the comment but returned no id.");
      return { id, url: body.commentUrn ? `https://www.linkedin.com/feed/update/${post}?commentUrn=${encodeURIComponent(body.commentUrn)}` : undefined };
    });
  },
};
