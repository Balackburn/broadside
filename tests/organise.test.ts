import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "broadside-organise-"));
process.env.BROADSIDE_DATA_DIR = dataDir;
process.env.BROADSIDE_SECRET = "test-secret";
process.env.BROADSIDE_ALLOW_PRIVATE_FETCH = "1";

const { connectAccount, getAccount, listAccounts, removeAccount } = await import("@/lib/accounts");
const { all, migrate, run, SCHEMA } = await import("@/lib/db");
const { createGroup, deleteGroup, getGroup, listGroups, updateGroup } = await import("@/lib/groups");
const { buildServer } = await import("@/lib/mcp");
const { deleteMedia, getMedia, listLibrary, mediaUses, saveMedia } = await import("@/lib/media");
const { createPost, deletePost, getPost, inspectPost, listPosts, publishNow, updatePost } = await import("@/lib/posts");
const { appendSignature, endsWithSignature } = await import("@/lib/sign");
const { createSignature, deleteSignature, listSignatures, setAccountSignature, updateSignature } = await import("@/lib/signatures");
const { createTag, deleteTag, listTags, renameTag } = await import("@/lib/tags");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const image = (name = "pixel.png") => saveMedia(new Uint8Array(PNG), name, "image/png");
const later = () => new Date(Date.now() + 3600_000).toISOString();

/** A stand-in Mastodon with a 500-character limit, so a signature can tip a post over it. */
const network = (async (input: RequestInfo | URL) => {
  if (String(input).endsWith("verify_credentials")) return Response.json({ acct: "me", avatar: null });
  return Response.json({ id: "1", url: "https://m.example/@me/1" });
}) as typeof fetch;

let one: string;
let two: string;
let three: string;
let masto: string;

beforeAll(async () => {
  one = (await connectAccount("sandbox", { name: "One" })).id;
  two = (await connectAccount("sandbox", { name: "Two" })).id;
  three = (await connectAccount("sandbox", { name: "Three" })).id;
  masto = (await connectAccount("mastodon", { instance: "https://m.example", access_token: "token" }, network)).id;
});

/* Media library ------------------------------------------------------------ */

describe("the media library", () => {
  it("lists every file newest first, with the posts that use it", async () => {
    const first = image("first.png");
    const second = image("second.png");
    const draft = await createPost({ content: "a draft with a picture", targets: [{ account_id: one }], media_ids: [first.id], draft: true });
    const library = listLibrary();
    expect(library.slice(0, 2).map((m) => m.id)).toEqual([second.id, first.id]);
    expect(library[0]).toMatchObject({ type: "image", content_type: "image/png", size: PNG.length, used_by: [] });
    expect(library[1].used_by).toEqual([{ post_id: draft.id, excerpt: "a draft with a picture", waiting: true }]);
  });

  it("refuses to delete a file a draft or a scheduled post still uses, and says how many", async () => {
    const media = image();
    const draft = await createPost({ content: "draft", targets: [{ account_id: one }], media_ids: [media.id], draft: true });
    expect(() => deleteMedia(media.id)).toThrow("1 post that has not gone out yet still uses this file.");
    const scheduled = await createPost({ content: "scheduled", targets: [{ account_id: one }], media_ids: [media.id], publish_at: later() });
    expect(() => deleteMedia(media.id)).toThrow("2 posts that have not gone out yet still use this file.");
    // The refusal names the posts, and nothing was removed: the record and the file are both still there.
    try {
      deleteMedia(media.id);
    } catch (error) {
      expect(new Set((error as { details: { post_ids: string[] } }).details.post_ids)).toEqual(new Set([draft.id, scheduled.id]));
    }
    expect(getMedia(media.id)).toBeDefined();
    expect(existsSync(path.join(dataDir, "media", media.id))).toBe(true);
    expect(getPost(draft.id)!.media.map((m) => m.id)).toEqual([media.id]);
  });

  it("deletes a file that only published posts use", async () => {
    const media = image();
    const published = await createPost({ content: "out already", targets: [{ account_id: one }], media_ids: [media.id] });
    expect(published.status).toBe("published");
    expect(mediaUses(media.id)).toEqual([{ post_id: published.id, excerpt: "out already", waiting: false }]);
    expect(deleteMedia(media.id)).toBe(true);
    expect(getMedia(media.id)).toBeUndefined();
    expect(existsSync(path.join(dataDir, "media", media.id))).toBe(false);
    // The post keeps its record; it just no longer has the picture to show.
    expect(getPost(published.id)!.media).toEqual([]);
  });

  it("lets a file go once the draft that used it is published, edited to drop it, or removed", async () => {
    const media = image();
    const a = await createPost({ content: "will publish", targets: [{ account_id: one }], media_ids: [media.id], draft: true });
    const b = await createPost({ content: "will drop it", targets: [{ account_id: one }], media_ids: [media.id], draft: true });
    const c = await createPost({ content: "will be removed", targets: [{ account_id: one }], media_ids: [media.id], draft: true });
    expect(() => deleteMedia(media.id)).toThrow("3 posts that have not gone out yet");
    await publishNow(a.id);
    await updatePost(b.id, { media_ids: [] });
    deletePost(c.id);
    expect(deleteMedia(media.id)).toBe(true);
  });

  it("keeps a file a failed post could still be retried with", async () => {
    const media = image();
    const failed = await createPost({ content: "this one will [fail]", targets: [{ account_id: one }], media_ids: [media.id] });
    expect(failed.status).toBe("failed");
    expect(() => deleteMedia(media.id)).toThrow("1 post that has not gone out yet still uses this file.");
  });

  it("deletes a file nothing uses, and treats anything that is not a media id as absent", () => {
    const media = image();
    expect(deleteMedia(media.id)).toBe(true);
    expect(deleteMedia(media.id)).toBe(false);
    expect(deleteMedia("../broadside.db")).toBe(false);
    expect(mediaUses("../broadside.db")).toEqual([]);
  });
});

/* Tags --------------------------------------------------------------------- */

describe("tags", () => {
  it("creates tags the first time a post uses them and reuses them whatever their case", async () => {
    const first = await createPost({ content: "tagged", targets: [{ account_id: one }], tags: ["Launch", "  weekly   notes "], draft: true });
    expect(first.tags).toEqual(["Launch", "weekly notes"]);
    const second = await createPost({ content: "tagged again", targets: [{ account_id: one }], tags: ["launch", "LAUNCH", "press"], draft: true });
    // One tag called Launch, spelled as it was first written.
    expect(second.tags).toEqual(["Launch", "press"]);
    const tags = listTags();
    expect(tags.map((t) => [t.name, t.posts])).toEqual([
      ["Launch", 2],
      ["press", 1],
      ["weekly notes", 1],
    ]);
    expect(createTag("LAUNCH").id).toBe(tags[0].id);
  });

  it("filters posts by tag, by name in any case", async () => {
    const tagged = listPosts({ tag: "launch", limit: 100 });
    expect(tagged.map((p) => p.content).sort()).toEqual(["tagged", "tagged again"]);
    expect(listPosts({ tag: "press", limit: 100 }).map((p) => p.content)).toEqual(["tagged again"]);
    expect(listPosts({ tag: "nothing has this", limit: 100 })).toEqual([]);
    expect(listPosts({ tag: "launch", status: "published", limit: 100 })).toEqual([]);
  });

  it("replaces a post's tags on update, and leaves them alone when the update does not mention them", async () => {
    const post = await createPost({ content: "to retag", targets: [{ account_id: one }], tags: ["alpha", "beta"], draft: true });
    expect((await updatePost(post.id, { content: "retagged later" })).tags).toEqual(["alpha", "beta"]);
    expect((await updatePost(post.id, { tags: ["beta", "gamma"] })).tags).toEqual(["beta", "gamma"]);
    expect((await updatePost(post.id, { tags: [] })).tags).toEqual([]);
    // Taking a tag off a post does not delete the tag.
    expect(listTags().map((t) => t.name)).toEqual(expect.arrayContaining(["alpha", "beta", "gamma"]));
  });

  it("renames a tag on every post that carries it", async () => {
    const a = await createPost({ content: "old name a", targets: [{ account_id: one }], tags: ["Q3"], draft: true });
    const b = await createPost({ content: "old name b", targets: [{ account_id: two }], tags: ["q3", "other"], draft: true });
    const tag = listTags().find((t) => t.name === "Q3")!;
    const renamed = renameTag(tag.id, "Third quarter");
    expect(renamed).toMatchObject({ id: tag.id, name: "Third quarter", posts: 2 });
    expect(getPost(a.id)!.tags).toEqual(["Third quarter"]);
    expect(getPost(b.id)!.tags).toEqual(["other", "Third quarter"]);
    expect(listPosts({ tag: "third quarter", limit: 100 })).toHaveLength(2);
    expect(listPosts({ tag: "Q3", limit: 100 })).toHaveLength(0);
    // Changing only the capitalisation is a rename like any other.
    expect(renameTag(tag.id, "THIRD QUARTER").name).toBe("THIRD QUARTER");
  });

  it("refuses to rename a tag onto another tag's name, or a tag that does not exist", () => {
    const other = listTags().find((t) => t.name === "other")!;
    expect(() => renameTag(other.id, "third QUARTER")).toThrow('A tag called "THIRD QUARTER" already exists.');
    expect(() => renameTag("tag_missing", "anything")).toThrow("No tag with id tag_missing.");
  });

  it("deletes a tag from every post and never deletes a post", async () => {
    const a = await createPost({ content: "keeps living a", targets: [{ account_id: one }], tags: ["doomed", "kept"], draft: true });
    const b = await createPost({ content: "keeps living b", targets: [{ account_id: one }], tags: ["doomed"], draft: true });
    const before = listPosts({ limit: 500 }).length;
    const doomed = listTags().find((t) => t.name === "doomed")!;
    expect(doomed.posts).toBe(2);
    expect(deleteTag(doomed.id)).toBe(true);
    expect(deleteTag(doomed.id)).toBe(false);
    expect(listPosts({ limit: 500 })).toHaveLength(before);
    expect(getPost(a.id)).toMatchObject({ content: "keeps living a", tags: ["kept"] });
    expect(getPost(b.id)).toMatchObject({ content: "keeps living b", tags: [] });
    expect(listTags().some((t) => t.name === "doomed")).toBe(false);
  });

  it("drops a post's tag links when the post is removed, and keeps the tag for the next post", async () => {
    const post = await createPost({ content: "short lived", targets: [{ account_id: one }], tags: ["lonely"], draft: true });
    deletePost(post.id);
    expect(listTags().find((t) => t.name === "lonely")!.posts).toBe(0);
  });

  it("gives the next occurrence of a repeating post the same tags", async () => {
    const first = await createPost({ content: "every week", targets: [{ account_id: one }], tags: ["weekly"], publish_at: later(), repeat: { every: "week" } });
    await publishNow(first.id);
    const next = listPosts({ limit: 500 }).find((p) => p.series?.id === first.series!.id && p.status === "scheduled")!;
    expect(next.id).not.toBe(first.id);
    expect(next.tags).toEqual(["weekly"]);
  });

  it("refuses names that are not short single-line names", async () => {
    const targets = [{ account_id: one }];
    await expect(createPost({ content: "x", targets, tags: ["a, b"], draft: true })).rejects.toThrow("A tag cannot contain a comma or a line break");
    await expect(createPost({ content: "x", targets, tags: ["   "], draft: true })).rejects.toThrow("A tag needs a name.");
    await expect(createPost({ content: "x", targets, tags: ["t".repeat(41)], draft: true })).rejects.toThrow("A tag can be 40 characters");
    await expect(createPost({ content: "x", targets, tags: "launch" as unknown as string[], draft: true })).rejects.toThrow("tags must be a list of names.");
    await expect(createPost({ content: "x", targets, tags: Array.from({ length: 21 }, (_, i) => `t${i}`), draft: true })).rejects.toThrow("A post can carry 20 tags; this has 21.");
    // A refused post creates no tags on the way.
    expect(listTags().some((t) => t.name === "t0")).toBe(false);
  });
});

/* Account groups ----------------------------------------------------------- */

describe("account groups", () => {
  it("names a set of accounts, and never shows credentials", () => {
    const group = createGroup({ name: "Launch day", account_ids: [one, two, one] });
    expect(group).toMatchObject({ name: "Launch day", account_ids: [one, two] });
    expect(group.accounts).toEqual([
      { id: one, platform: "sandbox", handle: "One" },
      { id: two, platform: "sandbox", handle: "Two" },
    ]);
    expect(JSON.stringify(listGroups())).not.toContain("credentials");
  });

  it("resolves group_id to exactly its accounts when a post is created", async () => {
    const group = listGroups().find((g) => g.name === "Launch day")!;
    const post = await createPost({ content: "to the group", group_id: group.id, draft: true });
    expect(post.targets.map((t) => t.account_id)).toEqual([one, two]);
    const checked = inspectPost({ content: "to the group", group_id: group.id });
    expect(checked.map((c) => c.account_id)).toEqual([one, two]);
  });

  it("replaces a post's targets with the group's accounts on update", async () => {
    const group = createGroup({ name: "Just three", account_ids: [three] });
    const post = await createPost({ content: "moving", targets: [{ account_id: one }, { account_id: two }], draft: true });
    const moved = await updatePost(post.id, { group_id: group.id });
    expect(moved.targets.map((t) => t.account_id)).toEqual([three]);
  });

  it("refuses targets and group_id together, an unknown group, and unknown members", async () => {
    const group = listGroups().find((g) => g.name === "Launch day")!;
    await expect(createPost({ content: "x", targets: [{ account_id: one }], group_id: group.id })).rejects.toThrow("Name the accounts with targets or with group_id, not both.");
    await expect(createPost({ content: "x", group_id: "grp_missing" })).rejects.toThrow("No group with id grp_missing.");
    await expect(createPost({ content: "x" })).rejects.toThrow("Choose at least one account to post to.");
    expect(() => createGroup({ name: "Ghosts", account_ids: ["acc_missing"] })).toThrow("No connected account has the id acc_missing.");
    expect(() => createGroup({ name: "Empty", account_ids: [] })).toThrow("A group needs at least one account.");
    expect(() => createGroup({ name: "launch DAY", account_ids: [one] })).toThrow('A group called "Launch day" already exists.');
    expect(() => createGroup({ name: " ", account_ids: [one] })).toThrow("A group needs a name.");
  });

  it("renames a group and replaces its members", () => {
    const group = createGroup({ name: "Dev channels", account_ids: [one] });
    expect(updateGroup(group.id, { name: "Developer channels" })).toMatchObject({ name: "Developer channels", account_ids: [one] });
    expect(updateGroup(group.id, { account_ids: [two, three] })).toMatchObject({ name: "Developer channels", account_ids: [two, three] });
    expect(() => updateGroup(group.id, { name: "Launch day" })).toThrow("already exists");
    expect(() => updateGroup("grp_missing", { name: "x" })).toThrow("No group with id grp_missing.");
    expect(deleteGroup(group.id)).toBe(true);
    expect(getGroup(group.id)).toBeUndefined();
    // Deleting a group disconnects nothing.
    expect(getAccount(two)).toBeDefined();
  });

  it("has one fewer member after an account is disconnected, and still posts to the rest", async () => {
    const leaving = (await connectAccount("sandbox", { name: "Leaving" })).id;
    const group = createGroup({ name: "With a leaver", account_ids: [one, leaving, two] });
    expect(group.account_ids).toEqual([one, two, leaving]);
    expect(removeAccount(leaving)).toBe(true);
    expect(getGroup(group.id)!.account_ids).toEqual([one, two]);
    expect(all("SELECT * FROM group_members WHERE account_id = ?", leaving)).toEqual([]);
    const post = await createPost({ content: "after the leaver left", group_id: group.id });
    expect(post.status).toBe("published");
    expect(post.targets.map((t) => t.account_id)).toEqual([one, two]);
  });

  it("refuses to post to a group whose accounts are all gone, by name", async () => {
    const only = (await connectAccount("sandbox", { name: "Only" })).id;
    const group = createGroup({ name: "Soon empty", account_ids: [only] });
    removeAccount(only);
    expect(getGroup(group.id)!.account_ids).toEqual([]);
    await expect(createPost({ content: "to nobody", group_id: group.id })).rejects.toThrow('The group "Soon empty" has no accounts left.');
  });
});

/* Signatures --------------------------------------------------------------- */

describe("signatures", () => {
  it("appends a signature as ordinary text, after a blank line", () => {
    expect(appendSignature("Hello", "the Acme team")).toBe("Hello\n\nthe Acme team");
    expect(appendSignature("Hello\n\n", "  the Acme team \n")).toBe("Hello\n\nthe Acme team");
    expect(appendSignature("", "#one #two")).toBe("#one #two");
    expect(appendSignature("Hello", "   ")).toBe("Hello");
    expect(endsWithSignature("Hello\n\nthe Acme team\n", "the Acme team")).toBe(true);
    expect(endsWithSignature("Hello", "the Acme team")).toBe(false);
  });

  it("saves, edits and deletes a signature", () => {
    const made = createSignature({ name: "  Team  sign-off ", content: "\nthe Acme team\n" });
    expect(made).toMatchObject({ name: "Team sign-off", content: "the Acme team", default_for: [] });
    expect(updateSignature(made.id, { content: "the whole Acme team" })).toMatchObject({ name: "Team sign-off", content: "the whole Acme team" });
    expect(updateSignature(made.id, { name: "Sign-off" }).name).toBe("Sign-off");
    expect(listSignatures().map((s) => s.name)).toContain("Sign-off");
    expect(() => createSignature({ name: "", content: "x" })).toThrow("A signature needs a name.");
    expect(() => createSignature({ name: "Blank", content: "  " })).toThrow("A signature needs some text.");
    expect(() => createSignature({ name: "Long", content: "x".repeat(2001) })).toThrow("A signature can be 2000 characters");
    expect(() => updateSignature("sig_missing", { name: "x" })).toThrow("No signature with id sig_missing.");
    expect(deleteSignature(made.id)).toBe(true);
    expect(deleteSignature(made.id)).toBe(false);
  });

  it("counts a signature against the network's limit like any other text", async () => {
    const signature = createSignature({ name: "Hashtags", content: "#broadside #opensource" });
    const body = "b".repeat(490);
    const signed = appendSignature(body, signature.content);
    // 490 characters fit Mastodon's 500 without the signature; with it the post is 514 and is refused.
    expect(inspectPost({ content: body, targets: [{ account_id: masto }] })[0]).toMatchObject({ ok: true, length: 490 });
    expect(inspectPost({ content: signed, targets: [{ account_id: masto }] })[0]).toMatchObject({ ok: false, length: 514, max_chars: 500, problems: ["Mastodon allows 500 characters; this is 514."] });
    await expect(createPost({ content: signed, targets: [{ account_id: masto }, { account_id: one }], draft: true })).rejects.toThrow("Mastodon allows 500 characters; this is 514.");
    // The same signed text fits the sandbox, where it is stored as part of the post and nowhere else.
    const post = await createPost({ content: signed, targets: [{ account_id: one }], draft: true });
    expect(post.content.endsWith("\n\n#broadside #opensource")).toBe(true);
  });

  it("gives an account a default signature, which is offered and never added by itself", async () => {
    const signature = createSignature({ name: "Default for one", content: "sent with care" });
    expect(setAccountSignature(one, signature.id).signature_id).toBe(signature.id);
    expect(listAccounts().find((a) => a.id === one)!.signature_id).toBe(signature.id);
    expect(listSignatures().find((s) => s.id === signature.id)!.default_for).toEqual([one]);
    // Posting to that account sends the text as written: the default is an offer the composer makes, not something the engine adds.
    const post = await createPost({ content: "exactly this", targets: [{ account_id: one }] });
    expect(post.content).toBe("exactly this");
    expect(post.targets[0].content_override).toBeNull();
    expect(setAccountSignature(one, null).signature_id).toBeNull();
    expect(() => setAccountSignature(one, "sig_missing")).toThrow("No signature with id sig_missing.");
    expect(() => setAccountSignature("acc_missing", signature.id)).toThrow("No account with id acc_missing.");
  });

  it("sets which accounts offer a signature in one go, one default per account", () => {
    const a = createSignature({ name: "A", content: "from A", default_for: [one, two] });
    expect(a.default_for).toEqual([one, two]);
    // Naming account two under another signature moves its default there.
    const b = createSignature({ name: "B", content: "from B", default_for: [two] });
    expect(listSignatures().find((s) => s.id === a.id)!.default_for).toEqual([one]);
    expect(b.default_for).toEqual([two]);
    expect(updateSignature(a.id, { default_for: [] }).default_for).toEqual([]);
    expect(() => updateSignature(a.id, { default_for: ["acc_missing"] })).toThrow("No connected account has the id acc_missing.");
  });

  it("clears an account's default when its signature is deleted", () => {
    const signature = createSignature({ name: "Going away", content: "bye", default_for: [three] });
    expect(getAccount(three)!.signature_id).toBe(signature.id);
    deleteSignature(signature.id);
    expect(getAccount(three)!.signature_id).toBeNull();
  });
});

/* MCP ---------------------------------------------------------------------- */

type ToolReply = { content: { text: string }[]; isError?: boolean };

async function agent() {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildServer({ baseUrl: "http://localhost:3000", local: false }).connect(serverSide);
  const client = new Client({ name: "organise-test", version: "1.0.0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolReply;
  const result = async <T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}) => JSON.parse((await call(name, args)).content[0].text) as T;
  return { client, call, result };
}

describe("MCP tools for tags, groups and signatures", () => {
  afterEach(() => {
    delete process.env.BROADSIDE_MCP_DRAFTS_ONLY;
  });

  it("lists tags, groups and signatures", async () => {
    const { client, result } = await agent();
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["list_tags", "list_groups", "list_signatures"]));
    expect((await result<{ name: string; posts: number }[]>("list_tags")).find((t) => t.name === "Launch")).toMatchObject({ posts: 2 });
    const groups = await result<{ name: string; account_ids: string[] }[]>("list_groups");
    expect(groups.find((g) => g.name === "Launch day")!.account_ids).toEqual([one, two]);
    const signatures = await result<{ name: string; content: string }[]>("list_signatures");
    expect(signatures.find((s) => s.name === "Hashtags")!.content).toBe("#broadside #opensource");
    expect(JSON.stringify([groups, signatures])).not.toContain("credentials");
    await client.close();
  });

  it("creates a post from a group_id with tags, updates both, and filters list_posts by tag", async () => {
    const { client, call, result } = await agent();
    const group = listGroups().find((g) => g.name === "Launch day")!;
    const post = await result<{ id: string; status: string; tags: string[]; targets: { account_id: string }[] }>("create_post", { content: "from an agent", group_id: group.id, tags: ["agent made", "Launch"] });
    expect(post.status).toBe("published");
    expect(post.targets.map((t) => t.account_id)).toEqual([one, two]);
    expect(post.tags).toEqual(["agent made", "Launch"]);
    const found = await result<{ id: string }[]>("list_posts", { tag: "AGENT MADE" });
    expect(found.map((p) => p.id)).toEqual([post.id]);

    const draft = await result<{ id: string }>("create_post", { content: "an agent's draft", targets: [{ account_id: three }], tags: ["first"], draft: true });
    const edited = await result<{ tags: string[]; targets: { account_id: string }[] }>("update_post", { post_id: draft.id, group_id: group.id, tags: ["second"] });
    expect(edited.tags).toEqual(["second"]);
    expect(edited.targets.map((t) => t.account_id)).toEqual([one, two]);

    const checked = await result<{ account_id: string }[]>("check_post", { content: "does it fit", group_id: group.id });
    expect(checked.map((c) => c.account_id)).toEqual([one, two]);
    const both = await call("create_post", { content: "x", targets: [{ account_id: one }], group_id: group.id });
    expect(both.isError).toBe(true);
    expect(both.content[0].text).toContain("not both");
    const neither = await call("create_post", { content: "x" });
    expect(neither.isError).toBe(true);
    expect(neither.content[0].text).toContain("Choose at least one account");
    await client.close();
  });

  it("still holds drafts-only: a group_id and tags never publish or schedule", async () => {
    process.env.BROADSIDE_MCP_DRAFTS_ONLY = "1";
    const { client, call, result } = await agent();
    const group = listGroups().find((g) => g.name === "Launch day")!;
    const held = await result<{ id: string; status: string; tags: string[]; targets: { account_id: string; status: string }[] }>("create_post", { content: "an agent's idea for the group", group_id: group.id, tags: ["held"] });
    expect(held.status).toBe("draft");
    expect(held.tags).toEqual(["held"]);
    expect(held.targets.map((t) => [t.account_id, t.status])).toEqual([
      [one, "draft"],
      [two, "draft"],
    ]);
    const pushed = await result<{ status: string; tags: string[] }>("update_post", { post_id: held.id, group_id: group.id, tags: ["held", "pushed"], draft: false });
    expect(pushed.status).toBe("draft");
    expect(pushed.tags).toEqual(["held", "pushed"]);
    const timed = await result<{ status: string }>("update_post", { post_id: held.id, group_id: group.id, draft: false, publish_at: later() });
    expect(timed.status).toBe("draft");
    expect((await call("publish_post", { post_id: held.id })).isError).toBe(true);
    expect(getPost(held.id)!.status).toBe("draft");
    await client.close();
  });
});

/* A database from before tags, groups and signatures ----------------------- */

describe("migrating a database from before these features", () => {
  it("adds the new tables and the account column in place, keeps every old row, and is safe to run again", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "broadside-older-")), "broadside.db");
    const old = new DatabaseSync(file);
    old.exec("PRAGMA foreign_keys = ON");
    old.exec(SCHEMA);
    const tables = () => old.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => String(t.name));
    const columns = (table: string) => old.prepare(`PRAGMA table_info(${table})`).all().map((c) => String(c.name));
    expect(tables()).not.toContain("tags");
    expect(columns("accounts")).not.toContain("signature_id");
    old.exec("INSERT INTO accounts (id, platform, label, handle, credentials, created_at) VALUES ('acc_old', 'sandbox', 'Sandbox', 'Old', 'sealed', '2026-01-01T00:00:00.000Z')");
    old.exec("INSERT INTO posts (id, content, media, created_at, updated_at) VALUES ('post_old', 'from before', '[\"med_before1\"]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')");
    old.exec("INSERT INTO media (id, filename, content_type, size, created_at) VALUES ('med_before1', 'old.png', 'image/png', 68, '2026-01-01T00:00:00.000Z')");

    migrate(old);
    migrate(old);

    expect(tables()).toEqual(expect.arrayContaining(["tags", "post_tags", "account_groups", "group_members", "signatures"]));
    expect(columns("accounts")).toContain("signature_id");
    expect({ ...old.prepare("SELECT handle, credentials, signature_id FROM accounts WHERE id = 'acc_old'").get() }).toEqual({ handle: "Old", credentials: "sealed", signature_id: null });
    expect({ ...old.prepare("SELECT content, media FROM posts WHERE id = 'post_old'").get() }).toEqual({ content: "from before", media: '["med_before1"]' });
    expect(old.prepare("SELECT COUNT(*) AS n FROM media").get()!.n).toBe(1);
    // The new tables work against the old rows: a group holds the old account until it is disconnected.
    old.exec("INSERT INTO account_groups (id, name, name_key, created_at) VALUES ('grp_1', 'Old friends', 'old friends', '2026-06-01T00:00:00.000Z')");
    old.exec("INSERT INTO group_members (group_id, account_id) VALUES ('grp_1', 'acc_old')");
    old.exec("DELETE FROM accounts WHERE id = 'acc_old'");
    expect(old.prepare("SELECT COUNT(*) AS n FROM group_members").get()!.n).toBe(0);
    old.close();
  });

  it("opens this test's own database with rows as plain objects", () => {
    const [tag] = all("SELECT id, name FROM tags LIMIT 1");
    expect(Object.getPrototypeOf(tag)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(listGroups()[0])).toBe(Object.prototype);
    expect(Object.getPrototypeOf(listSignatures()[0])).toBe(Object.prototype);
    expect(run("UPDATE tags SET name = name WHERE id = ?", String(tag.id))).toBe(1);
  });
});
