import { createHmac } from "node:crypto";
import { titleAndBody } from "./more";
import { blob, call, counted, images, json, PublishError, type Connector, type Context, type Credentials, type MediaItem, type PublishInput, type Reports } from "./types";

/**
 * Destinations that publish an article or a newsletter rather than a short
 * post: WordPress, Ghost and Listmonk. Each runs on an address its owner
 * types, so every request goes to that address through the guarded fetch the
 * caller hands in, like Mastodon's and Lemmy's.
 *
 * What they share:
 *
 * - A title. All three want one (Listmonk calls it the subject). It is the
 *   Title option when the post has one for this account, otherwise the first
 *   line of the text, and the rest of the text is the body. With neither, the
 *   post is refused; a title is never made up. A title too long for the site
 *   is left for the site to refuse in its own words: none of the three
 *   documents a limit, so none is enforced here and nothing is cut.
 * - A body written as plain text. Blank lines separate paragraphs, a line
 *   break stays a line break, and a web address becomes a link. Everything
 *   else is escaped, so text that looks like markup is shown as it was typed.
 * - Images, uploaded to the site itself. None of the three documents a limit
 *   on how many, so the 10 below is Broadside's own.
 */

const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One paragraph's text with its web addresses made into links. Punctuation that closes a sentence is not part of the address. */
function linked(text: string): string {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"]+/g)) {
    const address = match[0].replace(/[.,;:!?)\]]+$/, "");
    out += `${escapeHtml(text.slice(last, match.index))}<a href="${escapeHtml(address)}">${escapeHtml(address)}</a>`;
    last = match.index + address.length;
  }
  return out + escapeHtml(text.slice(last));
}

/** Plain text as the HTML these sites take. */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${linked(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

const figure = (image: { url: string; alt?: string }): string => `<figure><img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.alt ?? "")}"></figure>`;

/** The title and body of an article. `what` is the site's own word for the title, which is also what its option is called. */
function titled(network: string, input: PublishInput, what = "title"): { title: string; body: string } {
  const { title, body } = titleAndBody(input.text, input.options, Infinity);
  if (!title) throw new PublishError(`${network} needs a ${what}. Write it as the first line of the post, or set the ${what[0].toUpperCase()}${what.slice(1)} option for this account.`);
  return { title, body };
}

const trimmed = (address: string): string => address.trim().replace(/\/+$/, "");
const host = (address: string): string => new URL(address).host;
const chosen = (value: unknown, choices: string[]): string => (typeof value === "string" && choices.includes(value) ? value : choices[0]);
const listed = (value: unknown): string[] => (typeof value === "string" ? value.split(",").map((item) => item.trim()).filter(Boolean) : []);

/* WordPress --------------------------------------------------------------- */

/**
 * Read on 2026-11-15:
 *   https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/  (Basic auth with an application password)
 *   https://developer.wordpress.org/advanced-administration/security/application-passwords/  (where one is made; https)
 *   https://developer.wordpress.org/rest-api/reference/posts/  (POST /wp/v2/posts: title, content, status, featured_media)
 *   https://developer.wordpress.org/rest-api/reference/media/  (POST /wp/v2/media: alt_text; the answer's id and source_url)
 *   https://developer.wordpress.org/rest-api/reference/users/  (GET /wp/v2/users/me)
 *   https://developer.wordpress.org/reference/classes/wp_rest_attachments_controller/upload_from_file/
 *
 * Left open by those pages:
 * - The media reference lists the arguments of an upload and not how the file
 *   itself travels. The code reference shows the two ways WordPress reads it:
 *   a multipart form whose file field is named `file`, or the raw bytes with
 *   Content-Type and Content-Disposition headers. The form is used here.
 * - No limit is given for the length of a title or of the content.
 * - The API is assumed to be at /wp-json/, where the handbook's examples have
 *   it. A site with plain permalinks serves it at ?rest_route= instead and is
 *   not reached.
 * - This is the WordPress you host yourself. A site on WordPress.com is
 *   reached through public-api.wordpress.com with a different sign-in, which
 *   is not built.
 */
const WP_STATUSES = ["publish", "draft", "pending", "private"];
const wpBase = (c: Credentials) => `${trimmed(c.site)}/wp-json/wp/v2`;
const wpAuth = (c: Credentials) => ({ authorization: `Basic ${Buffer.from(`${c.username}:${c.application_password}`).toString("base64")}` });

export const wordpress: Connector = {
  id: "wordpress",
  name: "WordPress",
  docsUrl: "https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/",
  setup: [
    "This is for a WordPress site you host yourself, version 5.6 or later, served over https.",
    "In wp-admin open Users, Profile and scroll to Application Passwords. Type a name such as Broadside, press Add New Application Password and copy the password it shows once.",
    "Paste the site's address, your WordPress username and that application password here. Your normal password is never needed.",
    "The first line of each post becomes the article's title and the rest its content. The first image becomes the featured image.",
  ],
  fields: [
    { key: "site", label: "Site address", kind: "url", placeholder: "https://example.com", help: "The address of the site itself, without /wp-admin." },
    { key: "username", label: "Username", kind: "text", help: "The name you log in to WordPress with, not your display name." },
    { key: "application_password", label: "Application password", kind: "secret", placeholder: "abcd EFGH 1234 ijkl MNOP 5678", help: "From Users, Profile, Application Passwords in wp-admin. The spaces may stay." },
  ],
  options: [
    { key: "title", label: "Title", kind: "text", help: "Leave empty to use the first line of the post." },
    { key: "status", label: "Publish as", kind: "select", choices: WP_STATUSES, help: "publish puts it on the site at once. draft and pending leave it in wp-admin." },
  ],
  limits: { maxChars: 100_000, count: "graphemes", maxImages: 10, maxVideos: 0, requiresMedia: false },
  noThread: "WordPress publishes one article and has nothing to reply to it with.",
  noMetrics: "WordPress's REST API holds no count of views or likes for an article.",

  async verify(c, ctx) {
    const me = await call<{ name?: string; avatar_urls?: Record<string, string> }>(ctx, "WordPress", `${wpBase(c)}/users/me`, { headers: wpAuth(c) });
    return { handle: `${me.name || c.username} at ${host(c.site)}`, avatarUrl: me.avatar_urls?.["96"] };
  },

  async publish(input, c, ctx) {
    const { title, body } = titled("WordPress", input);
    const uploaded: { id: number; url: string; alt?: string }[] = [];
    for (const image of images(input)) {
      const form = new FormData();
      form.set("file", blob(await image.read(), image.contentType), image.filename);
      if (image.alt) form.set("alt_text", image.alt);
      const media = await call<{ id: number; source_url: string }>(ctx, "WordPress", `${wpBase(c)}/media`, { method: "POST", headers: wpAuth(c), body: form });
      uploaded.push({ id: media.id, url: media.source_url, alt: image.alt });
    }
    // The first image is the featured one, which themes show with the title. Any others follow the text.
    const [featured, ...rest] = uploaded;
    const made = await call<{ id: number; link?: string }>(
      ctx,
      "WordPress",
      `${wpBase(c)}/posts`,
      json({ title, content: [textToHtml(body), ...rest.map(figure)].filter(Boolean).join("\n"), status: chosen(input.options.status, WP_STATUSES), featured_media: featured?.id }, wpAuth(c)),
    );
    return { id: String(made.id), url: made.link };
  },
};

/* Ghost ------------------------------------------------------------------- */

/**
 * Read on 2026-11-15:
 *   https://docs.ghost.org/admin-api  (base address, Accept-Version, the token made from an Admin API key, what an integration may call)
 *   https://docs.ghost.org/admin-api/posts/creating-a-post  (POST /admin/posts/?source=html; title is the one required field)
 *   https://docs.ghost.org/admin-api/posts/overview  (the post object: id, url, status, feature_image, feature_image_alt)
 *   https://docs.ghost.org/admin-api/images/uploading-an-image  (POST /admin/images/upload/ with file and ref)
 *   https://docs.ghost.org/admin-api/site/overview  (GET /admin/site/ needs no key)
 *   https://docs.ghost.org/content-api/errors  (errors: [{ message, errorType }])
 *
 * Left open by those pages:
 * - Accept-Version names the oldest Ghost the caller can work with. Posting
 *   HTML with ?source=html is documented for the current API, and v5.0 is
 *   sent as the oldest version assumed to have it.
 * - Ghost turns the HTML into its own format and says the result may differ
 *   from what was sent.
 * - No limit is given for the length of a title or of the HTML.
 * - Video goes to an upload address the page of integration endpoints does
 *   not list, so only images are sent.
 */
const GHOST_STATUSES = ["published", "draft"];
const ghostBase = (c: Credentials) => `${trimmed(c.url).replace(/\/ghost$/, "")}/ghost/api/admin`;

/** The short-lived token Ghost asks for: HS256 over the key's secret half, good for five minutes, naming the key's id. */
export function ghostToken(key: string, now = Date.now()): string {
  const [id, secret, ...more] = key.trim().split(":");
  // The key is never quoted back: it is a secret whichever part of it was mistyped.
  if (!id || !secret || more.length || !/^(?:[0-9a-f]{2})+$/i.test(secret)) {
    throw new PublishError("That does not look like a Ghost Admin API key. It is two parts joined by a colon, as Ghost shows it for a custom integration.");
  }
  const iat = Math.floor(now / 1000);
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${part({ alg: "HS256", typ: "JWT", kid: id })}.${part({ iat, exp: iat + 300, aud: "/admin/" })}`;
  return `${unsigned}.${createHmac("sha256", Buffer.from(secret, "hex")).update(unsigned).digest("base64url")}`;
}

const ghostAuth = (c: Credentials) => ({ authorization: `Ghost ${ghostToken(c.admin_api_key)}`, "accept-version": "v5.0" });

export const ghost: Connector = {
  id: "ghost",
  name: "Ghost",
  docsUrl: "https://docs.ghost.org/admin-api",
  setup: [
    "In Ghost Admin open Settings, Integrations and add a custom integration. Name it Broadside.",
    "Copy its Admin API key, the long one with a colon in the middle, and paste it here with the address you open Ghost Admin at.",
    "The first line of each post becomes the article's title and the rest its content. The first image becomes the feature image.",
    "Publishing here puts the article on the site. It does not email it to members.",
  ],
  fields: [
    { key: "url", label: "Ghost address", kind: "url", placeholder: "https://example.ghost.io", help: "The address you open Ghost Admin at, without /ghost. On Ghost(Pro) it ends in .ghost.io." },
    { key: "admin_api_key", label: "Admin API key", kind: "secret", help: "From Settings, Integrations, your custom integration. Not the Content API key." },
  ],
  options: [
    { key: "title", label: "Title", kind: "text", help: "Leave empty to use the first line of the post." },
    { key: "status", label: "Publish as", kind: "select", choices: GHOST_STATUSES, help: "draft leaves it in Ghost Admin to finish there." },
    { key: "tags", label: "Tags, comma separated", kind: "text", help: "A tag Ghost does not have yet is created." },
  ],
  limits: { maxChars: 100_000, count: "graphemes", maxImages: 10, maxVideos: 0, requiresMedia: false },
  noThread: "Ghost publishes one article and has nothing to reply to it with.",
  noMetrics: "Ghost's Admin API documents no count of views or likes for an article.",

  async verify(c, ctx) {
    // The site's name is public. The second call is the one that proves the key.
    const { site } = await call<{ site: { title?: string; url?: string } }>(ctx, "Ghost", `${ghostBase(c)}/site/`);
    await call(ctx, "Ghost", `${ghostBase(c)}/posts/?limit=1&fields=id`, { headers: ghostAuth(c) });
    return { handle: site?.title || host(c.url) };
  },

  async publish(input, c, ctx) {
    const { title, body } = titled("Ghost", input);
    const uploaded: { url: string; alt?: string }[] = [];
    for (const image of images(input)) {
      const form = new FormData();
      form.set("file", blob(await image.read(), image.contentType), image.filename);
      form.set("ref", image.filename);
      const stored = await call<{ images?: { url: string }[] }>(ctx, "Ghost", `${ghostBase(c)}/images/upload/`, { method: "POST", headers: ghostAuth(c), body: form });
      const url = stored.images?.[0]?.url;
      if (!url) throw new PublishError("Ghost accepted the image but returned no address for it.");
      uploaded.push({ url, alt: image.alt });
    }
    const [feature, ...rest] = uploaded;
    const tags = listed(input.options.tags);
    const made = await call<{ posts?: { id: string; url?: string }[] }>(
      ctx,
      "Ghost",
      `${ghostBase(c)}/posts/?source=html`,
      json(
        {
          posts: [
            {
              title,
              html: [textToHtml(body), ...rest.map(figure)].filter(Boolean).join("\n") || undefined,
              status: chosen(input.options.status, GHOST_STATUSES),
              tags: tags.length ? tags : undefined,
              feature_image: feature?.url,
              feature_image_alt: feature?.alt || undefined,
            },
          ],
        },
        ghostAuth(c),
      ),
    );
    const article = made.posts?.[0];
    if (!article) throw new PublishError("Ghost accepted the article but returned nothing about it.");
    return { id: article.id, url: article.url };
  },
};

/* Listmonk ---------------------------------------------------------------- */

/**
 * Read on 2026-11-15, as published and as the Markdown they are built from
 * (github.com/knadh/listmonk, docs/docs/content/apis):
 *   https://listmonk.app/docs/apis/apis/  (the Authorization: token header; errors as { message })
 *   https://listmonk.app/docs/apis/campaigns/  (POST /api/campaigns, PUT /api/campaigns/{id}/status, GET /api/campaigns/{id})
 *   https://listmonk.app/docs/apis/lists/  (GET /api/lists)
 *   https://listmonk.app/docs/apis/media/  (POST /api/media with a file)
 *
 * A post becomes a campaign: its title is both the campaign's name and the
 * email's subject, and its text is the email. A new campaign is a draft; the
 * second call starts it, which sends it to the lists.
 *
 * Left open by those pages:
 * - The example answer to an upload gives the file's place as `uri`, a path
 *   on the Listmonk server, while reading one item back gives a whole `url`.
 *   Either is taken, and a path is read against the Listmonk address.
 * - No limit is given for the subject or the body.
 * - A campaign has no public address unless it is put in the archive, so no
 *   link is kept for it.
 */
const LISTMONK_MODES = ["send", "draft"];
const listmonkAuth = (c: Credentials) => ({ authorization: `token ${c.api_user}:${c.api_token}` });
const listmonkReports: Reports = { views: "Views", clicks: "Clicks" };

async function listmonkImage(image: MediaItem, c: Credentials, ctx: Context): Promise<{ url: string; alt?: string }> {
  const form = new FormData();
  form.set("file", blob(await image.read(), image.contentType), image.filename);
  const stored = await call<{ data?: { url?: string; uri?: string } }>(ctx, "Listmonk", `${trimmed(c.url)}/api/media`, { method: "POST", headers: listmonkAuth(c), body: form });
  const place = stored.data?.url ?? stored.data?.uri;
  if (!place) throw new PublishError("Listmonk accepted the image but returned no address for it.");
  return { url: new URL(place, `${trimmed(c.url)}/`).toString(), alt: image.alt };
}

export const listmonk: Connector = {
  id: "listmonk",
  name: "Listmonk",
  docsUrl: "https://listmonk.app/docs/apis/apis/",
  setup: [
    "In Listmonk open Admin, Users and create an API user with a role that may manage campaigns, get lists and upload media. Copy its token.",
    "Paste the address of your Listmonk, that user's name and its token, and the lists to send to.",
    "A post becomes a campaign and is sent to those lists at once. The first line is the email's subject and the rest is the email.",
    "To look before anything is sent, set the option Campaign to draft: the campaign is made in Listmonk and waits there.",
  ],
  fields: [
    { key: "url", label: "Listmonk address", kind: "url", placeholder: "https://newsletter.example.com" },
    { key: "api_user", label: "API user", kind: "text", placeholder: "broadside", help: "The name of the API user made under Admin, Users." },
    { key: "api_token", label: "API token", kind: "secret", help: "The token Listmonk made for that API user." },
    { key: "lists", label: "Lists", kind: "text", placeholder: "Default list", help: "The names of the lists to send to, separated by commas. A list's number works too." },
    { key: "from_email", label: "From address", kind: "text", optional: true, placeholder: "News <news@example.com>", help: "Leave empty to use the one in Listmonk's settings." },
  ],
  options: [
    { key: "title", label: "Subject", kind: "text", help: "Leave empty to use the first line of the post." },
    { key: "status", label: "Campaign", kind: "select", choices: LISTMONK_MODES, help: "send starts the campaign at once. draft makes it in Listmonk and sends nothing." },
  ],
  limits: { maxChars: 100_000, count: "graphemes", maxImages: 10, maxVideos: 0, requiresMedia: false },
  noThread: "Listmonk sends one email and has nothing to reply to it with.",

  async verify(c, ctx) {
    const found = await call<{ data?: { results?: { id: number; name: string }[] } }>(ctx, "Listmonk", `${trimmed(c.url)}/api/lists?minimal=true&per_page=all`, { headers: listmonkAuth(c) });
    const known = found.data?.results ?? [];
    const lists = listed(c.lists).map((wanted) => {
      const list = known.find((candidate) => String(candidate.id) === wanted || candidate.name.toLowerCase() === wanted.toLowerCase());
      if (!list) throw new PublishError(`This Listmonk has no list called "${wanted}" that the API user may see.`);
      return list;
    });
    if (!lists.length) throw new PublishError("Name at least one list to send to.");
    // The numbers are kept, so a list renamed later is still the same list.
    return { handle: `${lists.map((list) => list.name).join(", ")} at ${host(c.url)}`, credentials: { list_ids: lists.map((list) => list.id).join(",") } };
  },

  async publish(input, c, ctx) {
    const { title, body } = titled("Listmonk", input, "subject");
    const lists = listed(c.list_ids).map(Number);
    if (!lists.length) throw new PublishError("This Listmonk account has no lists to send to. Reconnect it and name them.");
    const pictures: { url: string; alt?: string }[] = [];
    for (const image of images(input)) pictures.push(await listmonkImage(image, c, ctx));
    // Listmonk requires a body. An email of one line carries that line as its text, as well as its subject.
    const html = [textToHtml(body || title), ...pictures.map(figure)].join("\n");
    const made = await call<{ data?: { id?: number } }>(
      ctx,
      "Listmonk",
      `${trimmed(c.url)}/api/campaigns`,
      json({ name: title, subject: title, lists, type: "regular", content_type: "html", body: html, altbody: body || title, messenger: "email", from_email: c.from_email || undefined }, listmonkAuth(c)),
    );
    const id = made.data?.id;
    if (id === undefined) throw new PublishError("Listmonk accepted the campaign but returned no id for it.");
    if (chosen(input.options.status, LISTMONK_MODES) === "send") {
      await call(ctx, "Listmonk", `${trimmed(c.url)}/api/campaigns/${id}/status`, { method: "PUT", headers: { ...listmonkAuth(c), "content-type": "application/json" }, body: JSON.stringify({ status: "running" }) }).catch((error) => {
        // The campaign exists by now. Trying the whole post again would make a second one, so this is never retried by itself.
        throw new PublishError(`Listmonk made campaign ${id} as a draft and would not start it. Start it in Listmonk, or delete it there before trying again. ${(error as Error).message}`);
      });
    }
    return { id: String(id) };
  },

  reports: listmonkReports,
  async metrics(input, c, ctx) {
    const found = await call<{ data?: { views?: number; clicks?: number } }>(ctx, "Listmonk", `${trimmed(c.url)}/api/campaigns/${encodeURIComponent(input.id)}?no_body=true`, { headers: listmonkAuth(c) });
    if (!found.data) throw new PublishError("Listmonk returned no campaign for this id. It may have been deleted.");
    return { metrics: counted(listmonkReports, { views: found.data.views, clicks: found.data.clicks }) };
  },
};
