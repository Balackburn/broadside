import { call, images, videos, PublishError, type Connector, type Context, type Credentials } from "./types";

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

export const linkedin: Connector = {
  id: "linkedin",
  name: "LinkedIn",
  docsUrl: "https://www.linkedin.com/developers/tools/oauth/token-generator",
  setup: [
    "Create an app at linkedin.com/developers and add the products Share on LinkedIn and Sign In with LinkedIn using OpenID Connect.",
    "Open the app's OAuth token generator, tick openid, profile and w_member_social, and generate a token.",
    "Paste it here. LinkedIn tokens last 60 days, so you will repeat the last step every two months.",
  ],
  fields: [
    { key: "access_token", label: "Access token", kind: "secret" },
    { key: "organization_id", label: "Company page id", kind: "text", optional: true, help: "Leave empty to post as yourself. Posting as a page needs w_organization_social." },
  ],
  limits: { maxChars: 3000, count: "graphemes", maxImages: 20, maxVideos: 0, requiresMedia: false, maxReplyChars: 1250 },

  async verify(c, ctx) {
    const me = await call<{ sub: string; name: string; picture?: string }>(ctx, "LinkedIn", "https://api.linkedin.com/v2/userinfo", {
      headers: { authorization: `Bearer ${c.access_token}` },
    });
    const author = c.organization_id ? `urn:li:organization:${c.organization_id}` : `urn:li:person:${me.sub}`;
    return { handle: c.organization_id ? `Page ${c.organization_id}` : me.name, avatarUrl: me.picture, credentials: { author } };
  },

  async publish(input, c, ctx) {
    if (videos(input).length) throw new PublishError("Video on LinkedIn is not supported yet.");
    const uploaded: { id: string; altText: string }[] = [];
    for (const image of images(input)) {
      const init = await call<{ value: { uploadUrl: string; image: string } }>(ctx, "LinkedIn", `${REST}/images?action=initializeUpload`, {
        method: "POST",
        headers: headers(c),
        body: JSON.stringify({ initializeUploadRequest: { owner: c.author } }),
      });
      await send(ctx, init.value.uploadUrl, {
        method: "PUT",
        headers: { authorization: `Bearer ${c.access_token}`, "content-type": image.contentType },
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
    const response = await send(ctx, `${REST}/posts`, { method: "POST", headers: headers(c), body: JSON.stringify(body) });
    const urn = response.headers.get("x-restli-id");
    if (!urn) throw new PublishError("LinkedIn accepted the post but returned no id.");
    return { id: urn, url: `https://www.linkedin.com/feed/update/${urn}/` };
  },

  // Each later part is a first-level comment on the post. Comment text is plain, so it is not escaped the way commentary is.
  async reply(input, c, ctx) {
    const post = input.root.id;
    const response = await send(ctx, `${REST}/socialActions/${encodeURIComponent(post)}/comments`, {
      method: "POST",
      headers: headers(c),
      body: JSON.stringify({ actor: c.author, object: post, message: { text: input.text } }),
    });
    const body = (await response.json().catch(() => ({}))) as { id?: string; commentUrn?: string };
    const id = body.commentUrn ?? body.id ?? response.headers.get("x-restli-id");
    if (!id) throw new PublishError("LinkedIn accepted the comment but returned no id.");
    return { id, url: body.commentUrn ? `https://www.linkedin.com/feed/update/${post}?commentUrn=${encodeURIComponent(body.commentUrn)}` : undefined };
  },
};
