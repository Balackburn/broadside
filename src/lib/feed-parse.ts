import { createHash } from "node:crypto";

/**
 * Reads RSS 2.0, RSS 1.0 (RDF) and Atom 1.0, written from their
 * specifications and nothing else. A feed is text from someone else's server,
 * so this reader is built to be hard to abuse:
 *
 * - It never processes a document type. A DOCTYPE that only names a public
 *   DTD is skipped and never fetched; one that declares anything of its own
 *   (the door to entity expansion and to external entities) is refused whole.
 * - Only the five XML entities and numeric references are decoded, once, each
 *   to a single character. Nothing a document says can make text grow.
 * - Depth, element count and the number of items read are capped, and every
 *   scan moves forward through the text, so a hostile feed costs no more time
 *   than its size.
 * - Titles and summaries are reduced to plain text. Markup, scripts and
 *   styles are dropped; what is left is characters to put in a post, never
 *   something to render or run.
 */

export class FeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedError";
  }
}

/** The most items read from one feed. Feeds list newest first, so these are the newest. */
export const MAX_ITEMS = 50;
const MAX_DEPTH = 64;
const MAX_NODES = 100_000;

export type FeedItem = {
  /** What an item is recognised by: its guid (RSS) or id (Atom) folded to one case, else its link, else a digest of its text. */
  key: string;
  title: string;
  /** An http(s) address, or "" when the item has none. */
  link: string;
  summary: string;
  /** When the item says it was published, as ISO 8601, or null when it does not say. */
  date: string | null;
};

export type ParsedFeed = { title: string; items: FeedItem[] };

type Node = { name: string; local: string; attrs: Record<string, string>; children: (Node | string)[] };

const NOT_XML = "This address did not return a feed Broadside can read: the XML is not well-formed.";

/* Character references ----------------------------------------------------- */

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** The named references HTML text in feeds commonly uses. A name not listed here stays as it was written. */
const HTML_ENTITIES: Record<string, string> = {
  ...XML_ENTITIES,
  nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", shy: "", zwj: "", zwnj: "",
  copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„",
  laquo: "«", raquo: "»", lsaquo: "‹", rsaquo: "›", bull: "•", middot: "·", deg: "°", prime: "′", Prime: "″", dagger: "†", permil: "‰",
  euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶", times: "×", divide: "÷", plusmn: "±", frac12: "½", frac14: "¼", frac34: "¾",
  larr: "←", rarr: "→", uarr: "↑", darr: "↓", iexcl: "¡", iquest: "¿",
  agrave: "à", aacute: "á", acirc: "â", atilde: "ã", auml: "ä", aring: "å", aelig: "æ", ccedil: "ç", egrave: "è", eacute: "é", ecirc: "ê", euml: "ë",
  igrave: "ì", iacute: "í", icirc: "î", iuml: "ï", ntilde: "ñ", ograve: "ò", oacute: "ó", ocirc: "ô", otilde: "õ", ouml: "ö", oslash: "ø",
  ugrave: "ù", uacute: "ú", ucirc: "û", uuml: "ü", yacute: "ý", szlig: "ß",
  Agrave: "À", Aacute: "Á", Acirc: "Â", Auml: "Ä", Aring: "Å", AElig: "Æ", Ccedil: "Ç", Egrave: "È", Eacute: "É", Ecirc: "Ê", Iacute: "Í", Ntilde: "Ñ",
  Oacute: "Ó", Ocirc: "Ô", Ouml: "Ö", Oslash: "Ø", Uacute: "Ú", Uuml: "Ü",
};

function character(code: number): string {
  if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "\ufffd";
  return String.fromCodePoint(code);
}

/** Decodes references in one pass. Each becomes one character from a fixed table or from its own number; the result is never read again for more. */
function decode(text: string, table: Record<string, string>): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g, (whole, ref: string) => {
    if (ref[0] !== "#") return Object.hasOwn(table, ref) ? table[ref] : whole;
    return character(ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10));
  });
}

/* XML ---------------------------------------------------------------------- */

const isSpace = (code: number): boolean => code === 32 || code === 9 || code === 10 || code === 13;
const NAME = /^[A-Za-z_][\w.\-:]*$/;

function element(name: string): Node {
  const colon = name.indexOf(":");
  return { name, local: (colon === -1 ? name : name.slice(colon + 1)).toLowerCase(), attrs: {}, children: [] };
}

/**
 * Builds the element tree of a feed, stopping once MAX_ITEMS items have been
 * read. It is strict: a tag that does not close the one open, or anything
 * else that is not well-formed, refuses the feed instead of guessing.
 */
function parseXml(xml: string): Node {
  const root = element("#document");
  const stack: Node[] = [root];
  const end = xml.length;
  let nodes = 0;
  let items = 0;
  let i = 0;
  while (i < end) {
    const top = stack[stack.length - 1];
    const lt = xml.indexOf("<", i);
    const upto = lt === -1 ? end : lt;
    // Text outside the root element is whitespace or a stray byte-order mark, and is not content.
    if (upto > i && stack.length > 1) top.children.push(decode(xml.slice(i, upto), XML_ENTITIES));
    if (lt === -1) break;
    if (xml.startsWith("<!--", lt)) {
      const close = xml.indexOf("-->", lt + 4);
      if (close === -1) break;
      i = close + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const close = xml.indexOf("]]>", lt + 9);
      if (stack.length > 1) top.children.push(xml.slice(lt + 9, close === -1 ? end : close));
      i = close === -1 ? end : close + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const close = xml.indexOf("?>", lt + 2);
      if (close === -1) break;
      i = close + 2;
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      // A document type. Before the root, one that only names a public DTD is stepped over and never fetched or read.
      // Anything with a subset of its own, or anywhere else, is where entity tricks live, and the feed is refused.
      const close = xml.indexOf(">", lt + 2);
      const declaration = xml.slice(lt, close === -1 ? end : close);
      if (stack.length > 1 || close === -1 || declaration.includes("[") || !/^<!DOCTYPE\s/i.test(declaration)) {
        throw new FeedError("This feed declares its own document type or entities. Broadside does not process those, so it did not read the feed.");
      }
      i = close + 1;
      continue;
    }
    if (xml[lt + 1] === "/") {
      const close = xml.indexOf(">", lt + 2);
      if (close === -1) break;
      const name = xml.slice(lt + 2, close).trim();
      if (stack.length === 1 || top.name !== name) throw new FeedError(NOT_XML);
      stack.pop();
      i = close + 1;
      if ((top.local === "item" || top.local === "entry") && ++items >= MAX_ITEMS) break;
      continue;
    }

    // A start tag: its name, then its attributes.
    let p = lt + 1;
    while (p < end && !isSpace(xml.charCodeAt(p)) && xml[p] !== ">" && xml[p] !== "/") p++;
    const name = xml.slice(lt + 1, p);
    if (!NAME.test(name)) throw new FeedError(NOT_XML);
    if (++nodes > MAX_NODES) throw new FeedError("This feed has more elements than Broadside will read.");
    const node = element(name);
    let selfClosing = false;
    for (;;) {
      while (p < end && isSpace(xml.charCodeAt(p))) p++;
      if (p >= end) throw new FeedError(NOT_XML);
      if (xml[p] === ">") {
        p++;
        break;
      }
      if (xml[p] === "/") {
        if (xml[p + 1] !== ">") throw new FeedError(NOT_XML);
        selfClosing = true;
        p += 2;
        break;
      }
      const start = p;
      while (p < end && xml[p] !== "=" && xml[p] !== ">" && xml[p] !== "/" && !isSpace(xml.charCodeAt(p))) p++;
      const key = xml.slice(start, p);
      while (p < end && isSpace(xml.charCodeAt(p))) p++;
      if (xml[p] !== "=" || !NAME.test(key)) throw new FeedError(NOT_XML);
      p++;
      while (p < end && isSpace(xml.charCodeAt(p))) p++;
      const quote = xml[p];
      if (quote !== '"' && quote !== "'") throw new FeedError(NOT_XML);
      const close = xml.indexOf(quote, p + 1);
      if (close === -1) throw new FeedError(NOT_XML);
      node.attrs[key.toLowerCase()] = decode(xml.slice(p + 1, close), XML_ENTITIES);
      p = close + 1;
    }
    top.children.push(node);
    if (!selfClosing) {
      if (stack.length >= MAX_DEPTH) throw new FeedError("This feed is nested more deeply than Broadside will read.");
      stack.push(node);
    }
    i = p;
  }
  return root;
}

const kids = (node: Node, local: string): Node[] => node.children.filter((child): child is Node => typeof child !== "string" && child.local === local);
/** The child with this name. One in the feed's own vocabulary (<title>) is preferred to an extension's element of the same name (<media:title>). */
function kid(node: Node | undefined, local: string): Node | undefined {
  if (!node) return undefined;
  const found = kids(node, local);
  return found.find((child) => !child.name.includes(":")) ?? found[0];
}

/** Every character inside an element, in order, with the elements themselves left out. */
function textOf(node: Node | undefined): string {
  if (!node) return "";
  let out = "";
  for (const child of node.children) out += typeof child === "string" ? child : textOf(child);
  return out;
}

/* HTML to plain text ------------------------------------------------------- */

/** Tags that end a line when their markup is taken away, so paragraphs do not run together. */
const BLOCK = new Set(["p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "section", "article", "ul", "ol", "table", "hr"]);

/**
 * Reduces HTML to the text a person would read. Tags go; scripts and styles
 * go with everything inside them; references are decoded once. What comes
 * back is plain characters: a "<" in it is a character, never markup.
 */
export function plainText(html: string): string {
  let out = "";
  let i = 0;
  const end = html.length;
  while (i < end) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      i = close === -1 ? end : close + 3;
      continue;
    }
    // A "<" that starts no tag is text, as in "1 < 2".
    if (!/[A-Za-z/!?]/.test(html[lt + 1] ?? "")) {
      out += "<";
      i = lt + 1;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    // A tag that never closes takes the rest with it. Dropping text is safe; leaving half a tag is not.
    if (gt === -1) break;
    const closing = html[lt + 1] === "/";
    const tag = html.slice(lt + (closing ? 2 : 1), gt).split(/[\s/]/, 1)[0].toLowerCase();
    if (!closing && (tag === "script" || tag === "style")) {
      i = afterClosing(html, tag, gt + 1);
      continue;
    }
    if (BLOCK.has(tag)) out += "\n";
    i = gt + 1;
  }
  return tidy(decode(out, HTML_ENTITIES));
}

/**
 * Where the text resumes after a script or style block: just past its closing
 * tag, or the end when it never closes. Each "</" is looked at once and the
 * search for ">" never starts over, so a block made of thousands of
 * half-closed tags costs no more than its length.
 */
function afterClosing(html: string, tag: string, from: number): number {
  for (let at = html.indexOf("</", from); at !== -1; at = html.indexOf("</", at + 2)) {
    if (html.slice(at + 2, at + 2 + tag.length).toLowerCase() !== tag) continue;
    const gt = html.indexOf(">", at + 2 + tag.length);
    return gt === -1 ? html.length : gt + 1;
  }
  return html.length;
}

/** Control characters out, runs of spaces closed up, no more than one blank line in a row. */
function tidy(text: string): string {
  return text
    .replace(/\r\n?|[\u2028\u2029]/g, "\n")
    .replace(/\p{Cc}/gu, (c) => (c === "\n" ? "\n" : c === "\t" ? " " : ""))
    .replace(/[ \u00a0]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/* Feeds -------------------------------------------------------------------- */

/** An Atom text construct: plain text unless it says it is HTML, or XHTML whose elements were already parsed away. */
function atomText(node: Node | undefined): string {
  if (!node) return "";
  const type = (node.attrs.type ?? "text").toLowerCase();
  return type === "html" || type === "text/html" ? plainText(textOf(node)) : tidy(textOf(node));
}

/** An item's address, kept only when it is a real http(s) address. A relative one is read against the feed's own address. */
function address(value: string, base: string): string {
  const raw = value.trim();
  if (!raw) return "";
  try {
    const url = new URL(raw, base);
    return /^https?:$/.test(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function when(value: string): string | null {
  const time = Date.parse(value.trim());
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** A stable digest for items that carry neither an id nor a link. It only tells two items apart. */
const digest = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 32);

/** The form two spellings of one guid or link share: a feed that changes the case of its ids has not published anything new. */
const fold = (value: string): string => value.trim().normalize("NFKC").toLowerCase();

function itemKey(guid: string, link: string, title: string, summary: string): string {
  if (guid.trim()) return `id:${fold(guid)}`;
  if (link) return `link:${fold(link)}`;
  return `text:${digest(`${title}\n${summary}`)}`;
}

function rssItem(node: Node, base: string): FeedItem {
  const guidNode = kid(node, "guid");
  const guid = textOf(guidNode);
  // RSS has <link>text</link>. An <atom:link href> beside it is the feed pointing at itself, so only a link with text counts.
  const linkText = kids(node, "link").map(textOf).find((text) => text.trim()) ?? "";
  const permalink = (guidNode?.attrs.ispermalink ?? "true").toLowerCase() !== "false" ? guid : "";
  const link = address(linkText, base) || address(permalink, base);
  const title = oneLine(plainText(textOf(kid(node, "title"))));
  const summary = plainText(textOf(kid(node, "description")) || textOf(kid(node, "encoded")));
  const date = when(textOf(kid(node, "pubdate")) || textOf(kid(node, "date")));
  return { key: itemKey(guid, link, title, summary), title, link, summary, date };
}

function atomEntry(node: Node, base: string): FeedItem {
  const id = textOf(kid(node, "id"));
  const links = kids(node, "link").filter((l) => l.attrs.href);
  const chosen = links.find((l) => (l.attrs.rel ?? "alternate").toLowerCase() === "alternate");
  const link = address(chosen?.attrs.href ?? "", base);
  const title = oneLine(atomText(kid(node, "title")));
  const summary = atomText(kid(node, "summary")) || atomText(kid(node, "content"));
  const date = when(textOf(kid(node, "published")) || textOf(kid(node, "updated")));
  return { key: itemKey(id, link, title, summary), title, link, summary, date };
}

/**
 * Parses a feed into its title and its newest items, in the order the feed
 * lists them. `base` is the feed's own address, for relative links. Throws
 * FeedError, with a reason fit to show a person, for anything it will not read.
 */
export function parseFeed(xml: string, base: string): ParsedFeed {
  const document = parseXml(xml.replace(/^\ufeff/, ""));
  const root = document.children.find((child): child is Node => typeof child !== "string");
  if (!root) throw new FeedError("This address did not return an RSS or Atom feed.");
  if (root.local === "feed") {
    return { title: oneLine(atomText(kid(root, "title"))), items: kids(root, "entry").slice(0, MAX_ITEMS).map((entry) => atomEntry(entry, base)) };
  }
  if (root.local === "rss" || root.local === "rdf") {
    const channel = kid(root, "channel");
    // RSS 2.0 keeps its items inside the channel; RSS 1.0 lists them beside it.
    const items = [...(channel ? kids(channel, "item") : []), ...kids(root, "item")];
    return { title: oneLine(plainText(textOf(kid(channel, "title")))), items: items.slice(0, MAX_ITEMS).map((item) => rssItem(item, base)) };
  }
  throw new FeedError("This address did not return an RSS or Atom feed.");
}

/** The text of a feed's bytes. UTF-8 unless the document or a byte-order mark says otherwise; an encoding this runtime does not know is read as UTF-8. */
export function decodeFeed(bytes: Uint8Array, contentType = ""): string {
  let label = "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) label = "utf-16le";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) label = "utf-16be";
  else {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 200));
    const declared = /<\?xml[^>]{0,150}encoding\s*=\s*["']([A-Za-z0-9._-]{1,40})["']/i.exec(head)?.[1] ?? /charset\s*=\s*"?([A-Za-z0-9._-]{1,40})/i.exec(contentType)?.[1];
    if (declared) label = declared;
  }
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
