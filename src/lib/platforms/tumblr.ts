import { tokenFields, withSession } from "./oauth2";
import { blob, call, images, json, videos, PublishError, type Choice, type Connector, type Context, type Credentials, type OAuthSpec, type PublishInput } from "./types";

/**
 * Tumblr, through its Neue Post Format.
 *
 * Read on 2026-11-15, from the documentation Tumblr keeps at github.com/tumblr/docs:
 *   https://github.com/tumblr/docs/blob/master/api.md  (OAuth2 Authorization; /user/info; /posts - Create/Reblog a Post (Neue Post Format); Rate Limits)
 *   https://github.com/tumblr/docs/blob/master/npf-spec.md  (text and image blocks, inline links, Post Content Limits)
 *
 * A post is a list of blocks. Each paragraph of the text is one text block, a
 * web address in it is marked as a link, and each image or video is a block
 * whose file travels in the same request.
 *
 * Left open by those pages:
 * - A text block holds 4,096 characters and a post up to 1,000 blocks, so
 *   Tumblr itself takes far more text than this. The whole post is held to
 *   4,096 here so that the limit can be shown before anything is sent, and
 *   each paragraph is still counted on its own, in code points as Tumblr
 *   counts, before the request is made.
 * - The upload example gives each image a width and height. The table of
 *   fields says neither is required, and Broadside does not know them, so
 *   they are left out.
 * - The upload example draws the JSON part with a Content-Type of its own.
 *   It is sent as a plain form field named `json`, which is how a form
 *   carries text.
 * - The answer to a new post is its id and nothing else. The link is built
 *   the way the documented `post_url` examples look for a blog on
 *   tumblr.com: https://{blog}.tumblr.com/post/{id}.
 * - The refresh request is listed as needing OAuth2, and its example sends
 *   only the app's key and secret with the refresh token. The example is
 *   followed.
 * - Tumblr asks every app to send one unchanging User-Agent. Nothing here
 *   sets one, so every request carries the same one Node sends.
 * - Notes are read with the app's key in the address (GET /notes is an "API
 *   key" method). Broadside keeps keys out of addresses, so no numbers are
 *   read.
 */
const TUMBLR = "https://api.tumblr.com/v2";
const STATES = ["published", "draft", "queue", "private"];
const PARAGRAPH = 4096;

type Blog = { name: string; title?: string; url?: string; primary?: boolean };
type Me = { response?: { user?: { name?: string; blogs?: Blog[] } } };

const bearer = (c: Credentials) => ({ authorization: `Bearer ${c.access_token}` });
const me = (c: Credentials, ctx: Context) => call<Me>(ctx, "Tumblr", `${TUMBLR}/user/info`, { headers: bearer(c) });
const shortName = (blog: string) => blog.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/\.tumblr\.com$/, "");

/**
 * Tumblr's access token lasts 42 minutes. The scope offline_access is what
 * makes it issue a refresh token, and each refresh returns a new one. A
 * sign-in ends with a choice of blog, since one account may hold several;
 * a second blog is connected by signing in again.
 */
const oauth: OAuthSpec = {
  authorizeUrl: "https://www.tumblr.com/oauth2/authorize",
  tokenUrl: `${TUMBLR}/oauth2/token`,
  scopes: ["basic", "write", "offline_access"],
  client: { id: "consumer_key", secret: "consumer_secret" },
  pkce: "none",
  clientAuth: "body",
  async exchange(tokens, app) {
    if (!tokens.refresh_token) throw new PublishError("Tumblr returned no refresh token, so the blog could not stay connected. Sign in again and approve every permission asked for.");
    return { ...app, ...tokenFields(tokens) };
  },
  choose: {
    prompt: "Pick the blog to post to.",
    // One sign-in holds one refresh token, and Tumblr replaces it each time it is used. Two blogs sharing it would each spend the other's.
    multiple: false,
    empty: "This Tumblr account has no blog it may post to.",
    async list(c, ctx) {
      const blogs = (await me(c, ctx)).response?.user?.blogs ?? [];
      return blogs.map((blog): Choice => ({ id: blog.name, name: blog.title || blog.name, detail: `${blog.name}.tumblr.com`, credentials: { ...c, blog: blog.name } }));
    },
  },
  paste: {
    required: ["consumer_key", "consumer_secret", "refresh_token", "blog"],
    help: "Authorise your app for the scopes basic, write and offline_access and keep the refresh token. The blog is its short name, the part before .tumblr.com.",
  },
};

/** One paragraph as a text block, with each web address in it marked as a link. Positions count code points, as Tumblr does. */
function textBlock(paragraph: string, number: number) {
  const length = [...paragraph].length;
  if (length > PARAGRAPH) throw new PublishError(`Tumblr allows 4,096 characters in one paragraph; paragraph ${number} is ${length}. Break it into shorter paragraphs.`);
  const formatting = [...paragraph.matchAll(/https?:\/\/[^\s<>"]+/g)].map((match) => {
    const url = match[0].replace(/[.,;:!?)\]]+$/, "");
    const start = [...paragraph.slice(0, match.index)].length;
    return { start, end: start + [...url].length, type: "link", url };
  });
  return formatting.length ? { type: "text", text: paragraph, formatting } : { type: "text", text: paragraph };
}

/** The blocks of a post and the files they name: media first, then the text under it, as a Tumblr photo post reads. */
function blocks(input: PublishInput) {
  const files = [...images(input), ...videos(input)].map((item, i) => ({ item, identifier: `media-${i}` }));
  const media = files.map(({ item, identifier }) =>
    item.type === "video"
      ? { type: "video", media: { type: item.contentType, identifier } }
      : { type: "image", media: [{ type: item.contentType, identifier }], ...(item.alt ? { alt_text: item.alt } : {}) },
  );
  const text = input.text.split(/\n+/).map((paragraph) => paragraph.trim()).filter(Boolean).map((paragraph, i) => textBlock(paragraph, i + 1));
  if (text.flatMap((block) => ("formatting" in block ? block.formatting : [])).length > 100) throw new PublishError("Tumblr allows 100 links in one post.");
  return { content: [...media, ...text], files };
}

export const tumblr: Connector = {
  id: "tumblr",
  name: "Tumblr",
  docsUrl: "https://github.com/tumblr/docs/blob/master/api.md",
  setup: [
    "Register an application at tumblr.com/oauth/apps. In its OAuth2 redirect URLs field, add the redirect address shown below.",
    "Paste the OAuth consumer key and the secret key Tumblr shows for the application, then continue to Tumblr, approve, and pick the blog to post to.",
    "Tumblr signs you in for 42 minutes at a time. Broadside renews that by itself whenever it posts.",
    "Tumblr allows 250 posts a day for one account.",
  ],
  fields: [
    { key: "consumer_key", label: "OAuth consumer key", kind: "text", help: "Shown for your application at tumblr.com/oauth/apps." },
    { key: "consumer_secret", label: "Secret key", kind: "secret", help: "The secret key of the same application." },
    { key: "refresh_token", label: "Refresh token", kind: "secret", hidden: true },
    { key: "blog", label: "Blog name", kind: "text", hidden: true, placeholder: "yourblog", help: "The part before .tumblr.com." },
  ],
  oauth,
  options: [
    { key: "state", label: "Post as", kind: "select", choices: STATES, help: "draft and queue leave it on Tumblr without publishing it now. private publishes it for you alone." },
    { key: "tags", label: "Tags, comma separated", kind: "text" },
  ],
  // 30 image blocks and one uploaded video are Tumblr's own limits for a post.
  limits: { maxChars: PARAGRAPH, count: "graphemes", maxImages: 30, maxVideos: 1, requiresMedia: false },
  noMetrics: "Tumblr counts likes, reblogs and replies together as notes, and its API gives them only to a request that carries the app's key in its address. Broadside does not read them.",

  async verify(c, ctx) {
    return withSession("Tumblr", oauth, c, ctx, async (live) => {
      const user = (await me(live, ctx)).response?.user;
      const wanted = shortName(c.blog);
      const blog = user?.blogs?.find((candidate) => candidate.name === wanted);
      if (!blog) throw new PublishError(`This Tumblr account has no blog called "${wanted}" that it may post to.`);
      return { handle: `${blog.name}.tumblr.com`, credentials: { blog: blog.name } };
    });
  },

  async publish(input, c, ctx) {
    const { content, files } = blocks(input);
    const tags = typeof input.options.tags === "string" ? input.options.tags.split(",").map((tag) => tag.trim()).filter(Boolean).join(",") : "";
    const state = typeof input.options.state === "string" && STATES.includes(input.options.state) ? input.options.state : "published";
    const body = { content, state, ...(tags ? { tags } : {}) };
    return withSession("Tumblr", oauth, c, ctx, async (live) => {
      let init: RequestInit = json(body, bearer(live));
      if (files.length) {
        // With files, the post's JSON is the first part of a form and each file follows under the name its block gave it.
        const form = new FormData();
        form.set("json", JSON.stringify(body));
        for (const { item, identifier } of files) form.set(identifier, blob(await item.read(), item.contentType), item.filename);
        init = { method: "POST", headers: bearer(live), body: form };
      }
      const made = await call<{ response?: { id?: string } }>(ctx, "Tumblr", `${TUMBLR}/blog/${encodeURIComponent(c.blog)}/posts`, init);
      const id = made.response?.id;
      if (!id) throw new PublishError("Tumblr accepted the post but returned no id for it.");
      return { id: String(id), url: `https://${c.blog}.tumblr.com/post/${id}` };
    });
  },
};
