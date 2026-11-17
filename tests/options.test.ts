import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.BROADSIDE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "broadside-options-"));
process.env.BROADSIDE_SECRET = "test-secret";
// The stand-in sites in this file are not real hosts.
process.env.BROADSIDE_ALLOW_PRIVATE_FETCH = "1";
process.env.BROADSIDE_ALLOW_ANY_WEBHOOK = "1";

const { connectAccount } = await import("@/lib/accounts");
const { connector, connectors, describe: describeNetwork, fits } = await import("@/lib/platforms");
const { missingTitle, noticeFor, optionProblems, optionSummary, optionsSet, optionsToSend, optionValue, titleAndBody } = await import("@/lib/platforms/options");
const { createPost, getPost, inspectPost, listPosts, publishNow, updatePost } = await import("@/lib/posts");

const later = () => new Date(Date.now() + 3600_000).toISOString();
const get = (id: string) => connector(id)!;
const wpOptions = get("wordpress").options!;

describe("what a target's options hold", () => {
  it("reads a value as text, and nothing from an option left empty", () => {
    const [title, status] = wpOptions;
    expect(optionValue(title, { title: "  Notes  " })).toBe("Notes");
    expect(optionValue(title, { title: "   " })).toBeNull();
    expect(optionValue(title, {})).toBeNull();
    expect(optionValue(title, { title: 7 })).toBeNull();
    expect(optionValue(status, { status: "draft" })).toBe("draft");
    expect(optionValue(status, { status: "" })).toBeNull();
    const silent = get("telegram").options![0];
    expect(optionValue(silent, { silent: true })).toBe("on");
    expect(optionValue(silent, { silent: false })).toBeNull();
    expect(optionValue(silent, { silent: "false" })).toBeNull();
    for (const nothing of [undefined, null, "text", ["a"], 4]) expect(optionValue(title, nothing)).toBeNull();
  });

  it("lists what is set in the order the connector declares, under each option's own label", () => {
    expect(optionsSet(wpOptions, { status: "draft", title: "Notes" })).toEqual([
      { key: "title", label: "Title", value: "Notes" },
      { key: "status", label: "Publish as", value: "draft" },
    ]);
    expect(optionSummary(wpOptions, { status: "draft", title: "Notes" })).toBe("Title: Notes, Publish as: draft");
    expect(optionSummary(get("listmonk").options!, { status: "draft" })).toBe("Campaign: draft");
    expect(optionSummary(get("telegram").options!, { silent: true })).toBe("Send without sound: on");
    expect(optionSummary(wpOptions, {})).toBe("");
    expect(optionSummary(wpOptions, { title: " " })).toBe("");
  });

  it("ignores an option the connector does not declare, without calling it a problem", () => {
    const stale = { title: "Notes", category: "an option from an older version" };
    expect(optionSummary(wpOptions, stale)).toBe("Title: Notes");
    expect(optionProblems(get("wordpress"), "A line", stale)).toEqual([]);
    expect(optionSummary([], stale)).toBe("");
  });

  it("drops a declared option left empty from what is stored, and keeps the rest as it came", () => {
    expect(optionsToSend(wpOptions, { title: "  ", status: "" })).toEqual({});
    expect(optionsToSend(wpOptions, { title: "Notes ", status: "draft" })).toEqual({ title: "Notes ", status: "draft" });
    expect(optionsToSend(get("telegram").options!, { silent: false })).toEqual({});
    expect(optionsToSend(get("telegram").options!, { silent: true })).toEqual({ silent: true });
    // A key the connector does not declare is passed on untouched: the webhook destination hands a caller's own settings to the receiver.
    expect(optionsToSend(wpOptions, { title: "", routing: { queue: "b" } })).toEqual({ routing: { queue: "b" } });
    expect(optionsToSend(wpOptions, undefined)).toEqual({});
    const given = { title: "" };
    optionsToSend(wpOptions, given);
    expect(given).toEqual({ title: "" });
  });

  it("every select names its choices, and every option has a key and a label", () => {
    for (const c of connectors) {
      const keys = (c.options ?? []).map((o) => o.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const option of c.options ?? []) {
        expect(option.label.length).toBeGreaterThan(0);
        if (option.kind === "select") expect(option.choices?.length ?? 0).toBeGreaterThan(1);
        else expect(option.choices).toBeUndefined();
      }
      // A notice that changes with an option names an option this connector declares, and one of its choices.
      for (const when of c.noticeWhen ?? []) expect(c.options?.find((o) => o.key === when.option)?.choices).toContain(when.is);
      if (c.needsTitle) expect(keys).toContain("title");
    }
  });
});

describe("a title where the destination must have one", () => {
  it("is the Title option, or the first line", () => {
    expect(titleAndBody("Title here\n\nBody text", {}, 100)).toEqual({ title: "Title here", body: "Body text" });
    expect(titleAndBody("Body only", { title: "Given" }, 100)).toEqual({ title: "Given", body: "Body only" });
  });

  it("is asked for in the words the connector fails with, and in the destination's own word for it", () => {
    expect(missingTitle(get("wordpress"), "", {})).toBe("WordPress needs a title. Write it as the first line of the post, or set the Title option for this account.");
    expect(missingTitle(get("ghost"), "\nA body under an empty first line", {})).toBe("Ghost needs a title. Write it as the first line of the post, or set the Title option for this account.");
    expect(missingTitle(get("listmonk"), "   ", { title: "  " })).toBe("Listmonk needs a subject. Write it as the first line of the post, or set the Subject option for this account.");
    // The word is the label of the option that carries it.
    for (const id of ["wordpress", "ghost", "listmonk"]) expect(get(id).options!.find((o) => o.key === "title")!.label.toLowerCase()).toBe(get(id).needsTitle);
  });

  it("is not missing when either is there, and never asked of a network that needs none", () => {
    expect(missingTitle(get("wordpress"), "A first line", {})).toBeNull();
    expect(missingTitle(get("wordpress"), "", { title: "Given" })).toBeNull();
    expect(optionProblems(get("listmonk"), "", { title: "Given" })).toEqual([]);
    expect(optionProblems(get("mastodon"), "", {})).toEqual([]);
    expect(optionProblems(get("reddit"), "", {})).toEqual([]);
    expect(connectors.filter((c) => c.needsTitle).map((c) => c.id)).toEqual(["wordpress", "ghost", "listmonk"]);
  });

  it("is what the connector itself refuses with", async () => {
    const never = (async () => {
      throw new Error("nothing should be sent");
    }) as unknown as typeof fetch;
    for (const id of ["wordpress", "ghost", "listmonk"]) {
      const error = await get(id).publish({ text: "", media: [], options: {} }, {}, { fetch: never }).catch((e: Error) => e);
      expect((error as Error).message).toBe(missingTitle(get(id), "", {}));
    }
  });
});

describe("a notice for a destination that cannot be taken back", () => {
  it("is set for Listmonk and Nostr, and for nothing else", () => {
    expect(connectors.filter((c) => c.notice).map((c) => c.id)).toEqual(["nostr", "listmonk"]);
  });

  it("says a Listmonk post emails the lists, until Campaign is set to draft", () => {
    const listmonk = fits(get("listmonk"));
    expect(noticeFor(listmonk, {})).toBe("Publishing emails every subscriber of the chosen lists at once, and an email cannot be unsent. Choose Campaign: draft to make it in Listmonk without sending.");
    expect(noticeFor(listmonk, { status: "send" })).toBe(noticeFor(listmonk, {}));
    expect(noticeFor(listmonk, undefined)).toBe(noticeFor(listmonk, {}));
    expect(noticeFor(listmonk, { status: "draft" })).toBe("Campaign is set to draft. The campaign is made in Listmonk and nothing is sent until you start it there.");
    // Only the exact choice counts: the connector sends for anything it does not recognise.
    expect(noticeFor(listmonk, { status: "Draft" })).toBe(noticeFor(listmonk, {}));
    expect(noticeFor(fits(get("wordpress")), { status: "draft" })).toBeNull();
  });

  it("reaches the browser and agents through describe(), with the options and no credentials", () => {
    const listmonk = describeNetwork(get("listmonk"));
    expect(listmonk.notice).toBe(get("listmonk").notice);
    expect(listmonk.notice_when).toEqual([{ option: "status", is: "draft", notice: "Campaign is set to draft. The campaign is made in Listmonk and nothing is sent until you start it there." }]);
    expect(listmonk.needs_title).toBe("subject");
    expect(listmonk.options.map((o) => o.key)).toEqual(["title", "status"]);
    const wordpress = describeNetwork(get("wordpress"));
    expect(wordpress).toMatchObject({ notice: null, notice_when: [], needs_title: "title" });
    expect(wordpress.options).toEqual(wpOptions);
    expect(describeNetwork(get("bluesky"))).toMatchObject({ options: [], notice: null, needs_title: null });
    // What the composer is handed about a network is its rules, and nothing a connection stored.
    expect(Object.keys(fits(get("listmonk"))).sort()).toEqual(["limits", "name", "needsTitle", "noThread", "notice", "noticeWhen", "options", "threads"]);
  });
});

/* The engine ----------------------------------------------------------------- */

type Sent = { url: string; method: string; body: Record<string, unknown> };
const sent: Sent[] = [];

/** Stands in for a WordPress site, a Listmonk and a webhook receiver, and keeps every body it was sent. */
const sites = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = String(input);
  const method = init.method ?? "GET";
  if (url.endsWith("/users/me")) return Response.json({ name: "Author" });
  if (url.includes("/api/lists")) return Response.json({ data: { results: [{ id: 4, name: "Readers" }] } });
  const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  sent.push({ url, method, body });
  if (url.endsWith("/wp/v2/posts")) return Response.json({ id: sent.length, link: `https://blog.example/?p=${sent.length}` });
  if (url.endsWith("/api/campaigns")) return Response.json({ data: { id: 40 + sent.length } });
  if (/\/api\/campaigns\/\d+\/status$/.test(url)) return Response.json({ data: { status: "running" } });
  return Response.json({ id: `hook-${sent.length}` });
}) as typeof fetch;

const articles = () => sent.filter((s) => s.url.endsWith("/wp/v2/posts")).map((s) => s.body);
const campaigns = () => sent.filter((s) => s.url.endsWith("/api/campaigns")).map((s) => s.body);
const starts = () => sent.filter((s) => /\/status$/.test(s.url));

let wp: string;
let wpTwo: string;
let letters: string;
let hook: string;
let sandbox: string;

beforeAll(async () => {
  wp = (await connectAccount("wordpress", { site: "https://blog.example", username: "author", application_password: "abcd efgh" }, sites)).id;
  wpTwo = (await connectAccount("wordpress", { site: "https://second.example", username: "author", application_password: "ijkl mnop" }, sites)).id;
  letters = (await connectAccount("listmonk", { url: "https://letters.example", api_user: "bot", api_token: "token", lists: "Readers" }, sites)).id;
  hook = (await connectAccount("webhook", { url: "https://hooks.example/in", name: "Receiver" }, sites)).id;
  sandbox = (await connectAccount("sandbox", { name: "Rehearsal" })).id;
});

beforeEach(() => {
  sent.length = 0;
});

const optionsOf = (post: { targets: { account_id: string; options: Record<string, unknown> }[] }, account: string) => post.targets.find((t) => t.account_id === account)!.options;

describe("options through the engine", () => {
  it("hands each target's options to its connector when a post is published", async () => {
    const post = await createPost(
      {
        content: "All of this is the body",
        targets: [
          { account_id: wp, options: { title: "A title for the first site", status: "draft" } },
          { account_id: wpTwo, options: { status: "private" } },
          { account_id: letters, options: { title: "A subject", status: "draft" } },
        ],
      },
      sites,
    );
    expect(post.status).toBe("published");
    // Two accounts on one network keep their own values.
    expect(articles()).toEqual(
      expect.arrayContaining([
        { title: "A title for the first site", content: "<p>All of this is the body</p>", status: "draft" },
        { title: "All of this is the body", content: "", status: "private" },
      ]),
    );
    expect(campaigns()).toHaveLength(1);
    expect(campaigns()[0]).toMatchObject({ subject: "A subject", name: "A subject" });
    // Campaign set to draft: the campaign is made and never started, so no email goes out.
    expect(starts()).toEqual([]);
  });

  it("starts a Listmonk campaign when Campaign is left at its default", async () => {
    await createPost({ content: "A subject line\nThe email", targets: [{ account_id: letters }] }, sites);
    expect(campaigns()).toHaveLength(1);
    expect(starts()).toHaveLength(1);
    expect(starts()[0].body).toEqual({ status: "running" });
  });

  it("keeps options on a draft, and sends them when the draft is published", async () => {
    const draft = await createPost({ content: "Body of the draft", targets: [{ account_id: wp, options: { title: "Kept on the draft", status: "pending" } }], draft: true }, sites);
    expect(sent).toEqual([]);
    expect(optionsOf(draft, wp)).toEqual({ title: "Kept on the draft", status: "pending" });
    expect(optionsOf(getPost(draft.id)!, wp)).toEqual({ title: "Kept on the draft", status: "pending" });
    expect(listPosts({ limit: 500 }).find((p) => p.id === draft.id)!.targets[0].options).toEqual({ title: "Kept on the draft", status: "pending" });
    await publishNow(draft.id, sites);
    expect(articles()).toEqual([{ title: "Kept on the draft", content: "<p>Body of the draft</p>", status: "pending" }]);
  });

  it("keeps options through an edit that names no targets, and replaces them with the targets an edit names", async () => {
    const post = await createPost({ content: "First words", targets: [{ account_id: wp, options: { title: "Stays", status: "draft" } }, { account_id: sandbox }], publish_at: later() }, sites);
    const reworded = await updatePost(post.id, { content: "Second words", tags: ["edited"] }, sites);
    expect(optionsOf(reworded, wp)).toEqual({ title: "Stays", status: "draft" });
    expect(optionsOf(reworded, sandbox)).toEqual({});
    // The composer sends every target again with what its section holds: a changed value, and none for an account back at its defaults.
    const changed = await updatePost(post.id, { targets: [{ account_id: wp, options: { status: "private" } }, { account_id: sandbox }] }, sites);
    expect(optionsOf(changed, wp)).toEqual({ status: "private" });
    const cleared = await updatePost(post.id, { targets: [{ account_id: wp }, { account_id: sandbox }] }, sites);
    expect(optionsOf(cleared, wp)).toEqual({});
    expect(sent).toEqual([]);
  });

  it("keeps options beside an account's own version of the text and a thread", async () => {
    const post = await createPost(
      { content: "Shared words", thread: ["a second part"], targets: [{ account_id: sandbox, content_override: "Words for the sandbox", options: { anything: "kept" } }], draft: true },
      sites,
    );
    expect(post.targets[0]).toMatchObject({ content_override: "Words for the sandbox", options: { anything: "kept" } });
    expect(post.thread).toEqual(["a second part"]);
    const edited = await updatePost(post.id, { thread: ["a second part", "and a third"] }, sites);
    expect(edited.targets[0]).toMatchObject({ content_override: "Words for the sandbox", options: { anything: "kept" } });
  });

  it("gives every occurrence of a repeating post the options of the one before", async () => {
    const first = await createPost({ content: "Weekly notes\nThe body", targets: [{ account_id: wp, options: { title: "Weekly", status: "draft" } }, { account_id: letters, options: { status: "draft" } }], publish_at: later(), repeat: { every: "week" } }, sites);
    await publishNow(first.id, sites);
    expect(articles()).toEqual([{ title: "Weekly", content: "<p>Weekly notes<br>The body</p>", status: "draft" }]);
    expect(starts()).toEqual([]);
    const second = listPosts({ limit: 500 }).find((p) => p.series?.id === first.series!.id && p.status === "scheduled")!;
    expect(second.id).not.toBe(first.id);
    expect(optionsOf(second, wp)).toEqual({ title: "Weekly", status: "draft" });
    expect(optionsOf(second, letters)).toEqual({ status: "draft" });
    // An edit to one occurrence carries forward to the next.
    await updatePost(second.id, { targets: [{ account_id: wp, options: { title: "Weekly, renamed" } }, { account_id: letters, options: { status: "draft" } }] }, sites);
    await publishNow(second.id, sites);
    const third = listPosts({ limit: 500 }).find((p) => p.series?.id === first.series!.id && p.status === "scheduled")!;
    expect(optionsOf(third, wp)).toEqual({ title: "Weekly, renamed" });
    expect(optionsOf(third, letters)).toEqual({ status: "draft" });
    expect(starts()).toEqual([]);
  });

  it("stores and passes on an option the connector does not declare, and does not refuse it", async () => {
    const post = await createPost({ content: "With settings of the caller's own", targets: [{ account_id: hook, options: { channel: "launch" } }, { account_id: wp, options: { title: "Titled", retired_option: "x" } }] }, sites);
    expect(post.status).toBe("published");
    expect(sent.find((s) => s.url === "https://hooks.example/in")!.body.options).toEqual({ channel: "launch" });
    expect(articles()).toEqual([{ title: "Titled", content: "<p>With settings of the caller's own</p>", status: "publish" }]);
    expect(optionsOf(post, wp)).toEqual({ title: "Titled", retired_option: "x" });
  });

  it("names a missing title in the dry run, in the words the target would fail with", async () => {
    const [untitled, titled, firstLine, own] = inspectPost({
      content: "\nOnly a body",
      targets: [{ account_id: wp }, { account_id: wpTwo, options: { title: "Given" } }, { account_id: letters, content_override: "A subject\nThe email" }, { account_id: letters, content_override: "" }],
    });
    expect(untitled).toMatchObject({ ok: false, problems: ["WordPress needs a title. Write it as the first line of the post, or set the Title option for this account."] });
    expect(titled).toMatchObject({ ok: true, problems: [] });
    expect(firstLine).toMatchObject({ ok: true, problems: [] });
    expect(own.problems).toContain("Listmonk needs a subject. Write it as the first line of the post, or set the Subject option for this account.");
    // The engine itself keeps finding it when the post goes out, as it did before the dry run could say so.
    const post = await createPost({ content: "\nOnly a body", targets: [{ account_id: wp }] }, sites);
    expect(post.targets[0]).toMatchObject({ status: "failed", error: untitled.problems[0] });
    expect(sent).toEqual([]);
  });
});
