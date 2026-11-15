import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "broadside-roles-"));
process.env.BROADSIDE_DATA_DIR = dataDir;
process.env.BROADSIDE_SECRET = "test-secret";
process.env.BROADSIDE_ALLOW_PRIVATE_FETCH = "1";
delete process.env.BROADSIDE_PASSWORD;
delete process.env.BROADSIDE_API_KEY;
delete process.env.BROADSIDE_PUBLIC_URL;

const { connectAccount } = await import("@/lib/accounts");
const { memberSecret, tokenActor } = await import("@/lib/actor");
const { all, run } = await import("@/lib/db");
const { createKey, createMemberKey } = await import("@/lib/keys");
const { buildServer, TOOL_ROLES } = await import("@/lib/mcp");
const members = await import("@/lib/members");
const { startOAuth } = await import("@/lib/oauth");
const { createPost, getPost } = await import("@/lib/posts");
const { atLeast, rank, ROLES } = await import("@/lib/roles");
const { memberSessionValue, SESSION_COOKIE } = await import("@/lib/session");
// The same reader `npm run check:routes` uses, so the test and the check cannot disagree about what a route declares.
const { declared, inspect } = (await import("../scripts/check-routes.mjs")) as unknown as {
  declared: () => { table: Record<string, Record<string, string>>; failures: string[] };
  inspect: (text: string) => { found: Record<string, string>; problems: string[] };
};

members.passwordCost.N = 1024;
members.passwordCost.p = 1;

type Role = (typeof ROLES)[number];
const aPassword = () => `test-${randomBytes(12).toString("hex")}`;

/**
 * Every route, every method, and the least role that may call it. This is
 * the table the README prints. A route added without a line here fails the
 * first test below, so nothing reaches the API without someone deciding who
 * it is for.
 *
 * "open" is a route anyone may call, each for a reason written in its file.
 */
const V = "viewer", E = "editor", A = "admin", O = "owner";
const EXPECTED: Record<string, Record<string, string>> = {
  "/api/health": { GET: "open" },
  "/api/login": { POST: "open", DELETE: "open" },
  "/api/join": { POST: "open" },
  "/media/[id]/[name]": { GET: "open" },
  "/mcp": { GET: V, POST: V, DELETE: V },
  "/oauth/[platform]/callback": { GET: A },

  "/api/v1/platforms": { GET: V },
  "/api/v1/accounts": { GET: V, POST: A },
  "/api/v1/accounts/[id]": { PATCH: E, DELETE: A },
  "/api/v1/oauth/[platform]/start": { POST: A },
  "/api/v1/oauth/choices/[id]": { GET: A, POST: A },
  "/api/v1/keys": { GET: A, POST: A },
  "/api/v1/keys/[id]": { DELETE: A },
  "/api/v1/feeds": { GET: V, POST: A },
  "/api/v1/feeds/[id]": { GET: V, PATCH: A, DELETE: A },
  "/api/v1/feeds/[id]/check": { POST: A },
  "/api/v1/feeds/[id]/test": { POST: A },
  "/api/v1/outgoing-webhooks": { GET: V, POST: A },
  "/api/v1/outgoing-webhooks/[id]": { GET: V, PATCH: A, DELETE: A },
  "/api/v1/outgoing-webhooks/[id]/test": { POST: A },

  "/api/v1/posts": { GET: V, POST: E },
  "/api/v1/posts/[id]": { GET: V, PATCH: E, DELETE: E },
  "/api/v1/posts/[id]/publish": { POST: E },
  "/api/v1/posts/[id]/cancel": { POST: E },
  "/api/v1/posts/[id]/targets/[targetId]/retry": { POST: E },
  "/api/v1/posts/[id]/analytics": { GET: V },
  "/api/v1/posts/[id]/analytics/refresh": { POST: E },
  "/api/v1/check": { POST: V },
  "/api/v1/analytics": { GET: V },
  "/api/v1/media": { GET: V, POST: E },
  "/api/v1/media/[id]": { PATCH: E, DELETE: E },
  "/api/v1/tags": { GET: V, POST: E },
  "/api/v1/tags/[id]": { PATCH: E, DELETE: E },
  "/api/v1/groups": { GET: V, POST: E },
  "/api/v1/groups/[id]": { GET: V, PATCH: E, DELETE: E },
  "/api/v1/signatures": { GET: V, POST: E },
  "/api/v1/signatures/[id]": { PATCH: E, DELETE: E },

  "/api/v1/team": { GET: V, POST: O },
  "/api/v1/team/invites": { POST: A },
  "/api/v1/team/invites/[id]": { DELETE: A },
  "/api/v1/team/members/[id]": { PATCH: A, DELETE: A },
  "/api/v1/team/password": { POST: V },
};

/** Routes a person does in the app and no key can: the team itself. */
const SESSION_ONLY = (address: string) => address.startsWith("/api/v1/team");
/** Routes only a key can call. */
const KEY_ONLY = (address: string) => address === "/mcp";
/** The browser coming back from a network: neither a key nor a cookie decides it. Tested on its own below. */
const BY_STATE = (address: string) => address === "/oauth/[platform]/callback";

const EXPECTED_TOOLS: Record<string, Role> = {
  list_platforms: "viewer",
  list_accounts: "viewer",
  list_media: "viewer",
  list_tags: "viewer",
  list_groups: "viewer",
  list_signatures: "viewer",
  check_post: "viewer",
  get_post: "viewer",
  list_posts: "viewer",
  get_analytics: "viewer",
  get_post_analytics: "viewer",
  list_feeds: "viewer",
  list_outgoing_webhooks: "viewer",
  upload_media: "editor",
  create_post: "editor",
  update_post: "editor",
  publish_post: "editor",
  cancel_post: "editor",
  stop_series: "editor",
  retry_target: "editor",
  delete_post: "editor",
  connect_account: "admin",
  disconnect_account: "admin",
};

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
const PARAMS = { id: "missing", platform: "missing", targetId: "missing", name: "missing.png" };
const root = path.resolve(import.meta.dirname, "..", "src", "app");

async function handler(address: string, method: string): Promise<Handler> {
  const exported = (await import(/* @vite-ignore */ path.join(root, address, "route.ts"))) as Record<string, Handler>;
  return exported[method];
}

/** A request to a route as one caller would send it. Nothing in it is valid input: the question is only whether the caller gets as far as being told so. */
function request(address: string, method: string, headers: Record<string, string>): Request {
  return new Request(`http://localhost${address.replace(/\[(\w+)\]/g, "missing")}`, { method, headers: { host: "localhost", ...headers } });
}

const call = async (address: string, method: string, headers: Record<string, string>) => (await handler(address, method))(request(address, method, headers), { params: Promise.resolve(PARAMS) });

const sessions = {} as Record<Role, Record<string, string>>;
const keys = {} as Record<Role, Record<string, string>>;
const people = {} as Record<Role, { id: string; name: string }>;
let sandbox: string;
let oldKey: string;

beforeAll(async () => {
  sandbox = (await connectAccount("sandbox", { name: "One" })).id;
  oldKey = createKey("from before the team").token;
});

describe("every route declares who may call it", () => {
  it("matches the table, with no route missing and none left over", () => {
    const { table, failures } = declared();
    expect(failures).toEqual([]);
    expect(Object.keys(table).sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(table).toEqual(EXPECTED);
  });

  it("is checked by a reader that fails a route which forgets", () => {
    expect(inspect(`export async function GET() { return new Response("hi"); }`).problems).toEqual(['GET is exported without route({ role }) or open("why")']);
    expect(inspect(`async function handle() {}\nexport { handle as GET, handle as POST };`).problems).toHaveLength(2);
    expect(inspect(`export const GET = route(() => listPosts());`).problems).toEqual(['GET does not declare a role: wrap it in route({ role: "…" }, …) or open("why", …)']);
    expect(inspect(`export const GET = route({ role: "superuser" }, () => 1);`).problems).toEqual(['GET declares the role "superuser", which is not one of viewer, editor, admin, owner']);
    expect(inspect(`export const GET = open("", () => 1);`).problems).toHaveLength(1);
    expect(inspect(`export const GET = async () => new Response("hi");`).problems).toHaveLength(1);
    expect(inspect(`const helper = 1;`).problems).toEqual(["exports no HTTP method this check can read"]);
    expect(inspect(`export const GET = route({ role: "viewer" }, () => 1);\nexport const POST = route<Ctx<"/x/[id]">>({ role: "admin", with: "session" }, () => 1);`)).toEqual({ found: { GET: "viewer", POST: "admin" }, problems: [] });
    expect(inspect(`const handle = route({ role: "viewer", with: "key" }, () => 1);\nexport const GET = handle;\nexport const POST = handle;`)).toEqual({ found: { GET: "viewer", POST: "viewer" }, problems: [] });
    expect(inspect(`export const GET = open("Monitors ask this with no credentials.", () => 1);`)).toEqual({ found: { GET: "open" }, problems: [] });
  });
});

describe("single-user mode: every route answers the operator as it always has", () => {
  const routes = Object.entries(EXPECTED).flatMap(([address, methods]) => Object.entries(methods).map(([method, role]) => ({ address, method, role })));

  it.each(routes.filter((r) => r.role !== "open" && !BY_STATE(r.address)))("$method $address lets the operator in, from the app and with a key", async ({ address, method }) => {
    expect(members.teamMode()).toBe(false);
    if (!KEY_ONLY(address)) {
      const fromApp = await call(address, method, { "sec-fetch-site": "same-origin" });
      expect([401, 403]).not.toContain(fromApp.status);
    }
    const withKey = await call(address, method, { authorization: `Bearer ${oldKey}` });
    // The team's own routes are for a person in the app in either mode. Everything else takes a key as before.
    expect(withKey.status === 401 || withKey.status === 403).toBe(SESSION_ONLY(address));
  });

  it.each(routes.filter((r) => r.role !== "open" && !BY_STATE(r.address)))("$method $address refuses a caller with no key and no app behind it", async ({ address, method }) => {
    expect((await call(address, method, {})).status).toBe(401);
    expect((await call(address, method, { "sec-fetch-site": "cross-site" })).status).toBe(401);
    expect((await call(address, method, { authorization: "Bearer bs_not-a-key" })).status).toBe(401);
  });
});

describe("in a team", () => {
  beforeAll(async () => {
    const owner = await members.startTeam({ name: "Olive Owner", password: aPassword() });
    people.owner = owner;
    for (const role of ["admin", "editor", "viewer"] as const) {
      const { token } = members.createInvite({ id: owner.id, role: "owner" }, { name: `${role} person`, role });
      people[role] = await members.acceptInvite(token, aPassword());
    }
    for (const role of ROLES) {
      const cookie = await memberSessionValue(people[role].id, memberSecret(people[role].id)!);
      sessions[role] = { "sec-fetch-site": "same-origin", cookie: `${SESSION_COOKIE}=${cookie}` };
      // Each member holds a key of their own role, made the way the app makes one.
      keys[role] = { authorization: `Bearer ${createMemberKey({ id: people[role].id, role }, `${role}'s key`, role).token}` };
    }
  });

  const routes = Object.entries(EXPECTED).flatMap(([address, methods]) => Object.entries(methods).map(([method, role]) => ({ address, method, role })));
  const guarded = routes.filter((r) => r.role !== "open" && !BY_STATE(r.address));
  const matrix = guarded.flatMap((r) => ROLES.map((caller) => ({ ...r, caller })));

  it("walks every route and method", () => {
    // 42 routes and 69 methods, of which the five open ones and the callback are checked elsewhere.
    expect(Object.keys(EXPECTED)).toHaveLength(42);
    expect(routes).toHaveLength(69);
    expect(guarded).toHaveLength(63);
    expect(matrix).toHaveLength(63 * 4);
  });

  it.each(matrix)("$method $address as $caller from the app (needs $role)", async ({ address, method, role, caller }) => {
    const response = await call(address, method, sessions[caller]);
    if (KEY_ONLY(address)) return expect(response.status).toBe(401);
    if (atLeast(caller, role as Role)) return expect([401, 403]).not.toContain(response.status);
    expect(response.status).toBe(403);
    expect((await response.json()).error).toEqual({ code: "forbidden", message: `This needs the ${role} role. You have ${caller}.` });
  });

  it.each(matrix)("$method $address with a key that has $caller (needs $role)", async ({ address, method, role, caller }) => {
    const response = await call(address, method, keys[caller]);
    if (SESSION_ONLY(address)) {
      // No key adds a member, changes a role or sets a password, whatever its role.
      expect(response.status).toBe(403);
      return expect((await response.json()).error.code).toBe("needs_person");
    }
    if (atLeast(caller, role as Role)) return expect([401, 403]).not.toContain(response.status);
    expect(response.status).toBe(403);
    if (!KEY_ONLY(address)) expect((await response.json()).error).toEqual({ code: "forbidden", message: `This needs the ${role} role. This key has ${caller}.` });
  });

  it.each(guarded)("$method $address refuses no cookie, the shared password's cookie, another site, and a dead key", async ({ address, method }) => {
    expect((await call(address, method, { "sec-fetch-site": "same-origin" })).status).toBe(401);
    // A member's cookie sent by a page on another site is not a member asking.
    expect((await call(address, method, { ...sessions.owner, "sec-fetch-site": "cross-site" })).status).toBe(401);
    expect((await call(address, method, { ...sessions.owner, "sec-fetch-site": "same-site" })).status).toBe(401);
    expect((await call(address, method, { cookie: sessions.owner.cookie })).status).toBe(401);
    expect((await call(address, method, { authorization: "Bearer bs_not-a-key" })).status).toBe(401);
  });

  it("treats a key from before the team as an editor that belongs to no one, on every route", async () => {
    for (const { address, method, role } of guarded) {
      const response = await call(address, method, { authorization: `Bearer ${oldKey}` });
      const allowed = !SESSION_ONLY(address) && atLeast("editor", role as Role);
      expect([address, method, response.status === 401 || response.status === 403]).toEqual([address, method, !allowed]);
    }
  });

  it("takes a role change on the very next request, for a session and for a key", async () => {
    const owner = { id: people.owner.id, role: "owner" as const };
    const asEditor = () => call("/api/v1/tags", "POST", sessions.editor);
    const withEditorKey = () => call("/api/v1/tags", "POST", keys.editor);
    expect([401, 403]).not.toContain((await asEditor()).status);
    expect([401, 403]).not.toContain((await withEditorKey()).status);
    members.setRole(owner, people.editor.id, "viewer");
    expect((await asEditor()).status).toBe(403);
    expect((await withEditorKey()).status).toBe(403);
    members.setRole(owner, people.editor.id, "editor");
    expect([401, 403]).not.toContain((await asEditor()).status);
    expect([401, 403]).not.toContain((await withEditorKey()).status);
  });

  it("shuts a disabled member out of every route, by cookie and by key", async () => {
    const owner = { id: people.owner.id, role: "owner" as const };
    members.setDisabled(owner, people.admin.id, true);
    for (const { address, method } of guarded) {
      expect([address, method, (await call(address, method, sessions.admin)).status]).toEqual([address, method, 401]);
      expect([address, method, (await call(address, method, keys.admin)).status]).toEqual([address, method, 401]);
    }
    members.setDisabled(owner, people.admin.id, false);
    // Enabled again, the old cookie stays dead and the key, which is theirs, works again.
    expect((await call("/api/v1/posts", "GET", sessions.admin)).status).toBe(401);
    expect((await call("/api/v1/posts", "GET", keys.admin)).status).toBe(200);
    const cookie = await memberSessionValue(people.admin.id, memberSecret(people.admin.id)!);
    sessions.admin = { "sec-fetch-site": "same-origin", cookie: `${SESSION_COOKIE}=${cookie}` };
    expect((await call("/api/v1/posts", "GET", sessions.admin)).status).toBe(200);
  });

  describe("escalation, tried through the API", () => {
    const send = async (address: string, method: string, headers: Record<string, string>, body: unknown, params: Record<string, string> = PARAMS) => {
      const route = await handler(address, method);
      const response = await route(new Request(`http://localhost${address}`, { method, headers: { host: "localhost", "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), { params: Promise.resolve(params) });
      return { status: response.status, body: (await response.json()) as { data?: Record<string, unknown>; error?: { code: string; message: string } } };
    };

    it("stops an admin editing an owner, or raising their own role", async () => {
      const onOwner = await send("/api/v1/team/members/[id]", "PATCH", sessions.admin, { role: "viewer" }, { id: people.owner.id });
      expect(onOwner).toMatchObject({ status: 400, body: { error: { message: "Changing Olive Owner's role needs an owner." } } });
      const disableOwner = await send("/api/v1/team/members/[id]", "PATCH", sessions.admin, { disabled: true }, { id: people.owner.id });
      expect(disableOwner.status).toBe(400);
      const removeOwner = await send("/api/v1/team/members/[id]", "DELETE", sessions.admin, undefined, { id: people.owner.id });
      expect(removeOwner.status).toBe(400);
      const onSelf = await send("/api/v1/team/members/[id]", "PATCH", sessions.admin, { role: "owner" }, { id: people.admin.id });
      expect(onSelf).toMatchObject({ status: 400, body: { error: { message: "You cannot change your own role. Ask another owner." } } });
      const makeOwner = await send("/api/v1/team/members/[id]", "PATCH", sessions.admin, { role: "owner" }, { id: people.viewer.id });
      expect(makeOwner).toMatchObject({ status: 400, body: { error: { message: "You can give a role up to your own, which is admin." } } });
      const inviteOwner = await send("/api/v1/team/invites", "POST", sessions.admin, { name: "An Owner Please", role: "owner" });
      expect(inviteOwner.status).toBe(400);
      expect(members.getMember(people.owner.id)).toMatchObject({ role: "owner", disabled_at: null });
      expect(members.getMember(people.admin.id)!.role).toBe("admin");
      expect(members.getMember(people.viewer.id)!.role).toBe("viewer");
    });

    it("stops the last owner being demoted, disabled or removed, even by themselves", async () => {
      for (const body of [{ role: "admin" }, { disabled: true }]) {
        expect((await send("/api/v1/team/members/[id]", "PATCH", sessions.owner, body, { id: people.owner.id })).status).toBe(400);
      }
      expect((await send("/api/v1/team/members/[id]", "DELETE", sessions.owner, undefined, { id: people.owner.id })).status).toBe(400);
      expect(members.getMember(people.owner.id)).toMatchObject({ role: "owner", disabled_at: null });
    });

    it("stops an editor making a key at all, and an admin making one above admin", async () => {
      const byEditor = await send("/api/v1/keys", "POST", sessions.editor, { name: "an admin key for an editor", role: "admin" });
      expect(byEditor).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
      const tooHigh = await send("/api/v1/keys", "POST", sessions.admin, { name: "an owner key for an admin", role: "owner" });
      expect(tooHigh).toMatchObject({ status: 400, body: { error: { message: "A key can have a role up to your own, which is admin." } } });
      // An admin's key that was made as an editor cannot be used to mint anything.
      const editorKeyOfAdmin = createMemberKey({ id: people.admin.id, role: "admin" }, "lowered", "editor").token;
      expect((await send("/api/v1/keys", "POST", { authorization: `Bearer ${editorKeyOfAdmin}` }, { name: "minted", role: "admin" })).status).toBe(403);
      // A key that is an admin's can make another, and it cannot outrank the key that made it.
      const made = await send("/api/v1/keys", "POST", keys.admin, { name: "made by a key", role: "admin" });
      expect(made.status).toBe(200);
      expect(made.body.data!.key).toMatchObject({ member_id: people.admin.id, role: "admin" });
      expect((await send("/api/v1/keys", "POST", keys.admin, { name: "outranks its maker", role: "owner" })).status).toBe(400);
      expect(all("SELECT id FROM api_keys WHERE name IN ('an admin key for an editor', 'an owner key for an admin', 'minted', 'outranks its maker')")).toEqual([]);
    });

    it("shows keys to admins with who each belongs to, and never a token", async () => {
      const listed = await send("/api/v1/keys", "GET", sessions.admin, undefined);
      const rows = listed.body.data as unknown as { name: string; owner: string | null; member_id: string | null; role: string | null }[];
      expect(rows.find((k) => k.name === "from before the team")).toMatchObject({ owner: null, member_id: null, role: null });
      expect(rows.find((k) => k.name === "editor's key")).toMatchObject({ owner: "editor person", role: "editor" });
      expect(JSON.stringify(listed.body)).not.toMatch(/bs_[A-Za-z0-9_-]{20,}/);
    });

    it("records who wrote a post from the session or the key, never from the body", async () => {
      const content = { content: "attributed", targets: [{ account_id: sandbox }], draft: true, created_by: people.owner.id, author: { id: people.owner.id } };
      const bySession = await send("/api/v1/posts", "POST", sessions.editor, content);
      expect(bySession.body.data!.author).toEqual({ id: people.editor.id, name: "editor person" });
      const byKey = await send("/api/v1/posts", "POST", keys.admin, content);
      expect(byKey.body.data!.author).toEqual({ id: people.admin.id, name: "admin person" });
      const byOldKey = await send("/api/v1/posts", "POST", { authorization: `Bearer ${oldKey}` }, content);
      expect(byOldKey.body.data!.author).toBeNull();
    });

    it("lets a member change only their own password, and never by key", async () => {
      expect((await send("/api/v1/team/password", "POST", keys.owner, { current: "x", next: aPassword() })).status).toBe(403);
      const wrong = await send("/api/v1/team/password", "POST", sessions.viewer, { current: aPassword(), next: aPassword() });
      expect(wrong).toMatchObject({ status: 400, body: { error: { message: "That is not your current password." } } });
    });

    it("shows the team to members, and invites only to admins", async () => {
      const waiting = members.createInvite({ id: people.owner.id, role: "owner" }, { name: "Still Waiting", role: "viewer" });
      const forViewer = await send("/api/v1/team", "GET", sessions.viewer, undefined);
      expect(forViewer.body.data).toMatchObject({ team: true, me: { id: people.viewer.id, role: "viewer" }, invites: [] });
      const forAdmin = await send("/api/v1/team", "GET", sessions.admin, undefined);
      expect((forAdmin.body.data!.invites as { name: string; invited_by: string }[]).find((i) => i.name === "Still Waiting")).toMatchObject({ invited_by: "Olive Owner" });
      for (const seen of [forViewer, forAdmin]) expect(JSON.stringify(seen.body)).not.toMatch(/scrypt|password_hash|session_nonce|token/);
      members.revokeInvite({ id: people.owner.id, role: "owner" }, waiting.invite.id);
    });

    it("hands an invite link back once, built from this Broadside's own address", async () => {
      const made = await send("/api/v1/team/invites", "POST", sessions.admin, { name: "Linked In", role: "editor" });
      expect(made.status).toBe(200);
      const { path: joinPath, url, invite } = made.body.data as { path: string; url: string; invite: { id: string } };
      expect(joinPath).toMatch(/^\/join\/[A-Za-z0-9_-]{43}$/);
      expect(url).toBe(`http://localhost${joinPath}`);
      // Sent under a host name nothing has checked, the reply carries the path and no address.
      const route = await handler("/api/v1/team/invites", "POST");
      process.env.BROADSIDE_PASSWORD = "the shared one";
      const elsewhere = await route(new Request("http://evil.example/api/v1/team/invites", { method: "POST", headers: { ...sessions.admin, host: "evil.example", "content-type": "application/json" }, body: JSON.stringify({ name: "From Elsewhere", role: "viewer" }) }), { params: Promise.resolve({}) });
      delete process.env.BROADSIDE_PASSWORD;
      const body = (await elsewhere.json()) as { data: { url: string | null; path: string; invite: { id: string } } };
      expect(body.data.url).toBeNull();
      expect(body.data.path).toMatch(/^\/join\//);
      members.revokeInvite({ id: people.owner.id, role: "owner" }, invite.id);
      members.revokeInvite({ id: people.owner.id, role: "owner" }, body.data.invite.id);
    });

    it("refuses a second team, and a team set up with a key", async () => {
      expect((await send("/api/v1/team", "POST", sessions.owner, { name: "Second Team", password: aPassword() })).body.error!.message).toBe("This Broadside already has a team. Invite people from the Team screen.");
      expect((await send("/api/v1/team", "POST", keys.owner, { name: "By Key", password: aPassword() })).status).toBe(403);
    });
  });

  describe("the callback from a network", () => {
    const callback = async (state: string) => {
      const route = await handler("/oauth/[platform]/callback", "GET");
      return route(new Request(`http://localhost/oauth/x/callback?state=${state}&code=abc`, { headers: { host: "localhost", "sec-fetch-site": "cross-site" } }), { params: Promise.resolve({ platform: "x" }) });
    };
    const begin = (who: Role) => new URL(startOAuth("x", { client_id: "id", client_secret: "secret" }, "http://localhost", { member_id: people[who].id, role: "admin" }).url).searchParams.get("state")!;
    const pendingStates = () => all("SELECT state FROM oauth_pending").length;

    it("is refused, with the sign-in left unused, when whoever began it is no longer an admin", async () => {
      const state = begin("admin");
      members.setRole({ id: people.owner.id, role: "owner" }, people.admin.id, "editor");
      const before = pendingStates();
      const response = await callback(state);
      expect(response.status).toBe(303);
      members.setRole({ id: people.owner.id, role: "owner" }, people.admin.id, "admin");
      expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe("Whoever started this sign-in can no longer connect accounts. Ask an admin to start it again.");
      expect(pendingStates()).toBe(before);
    });

    it("says so when the state is not a sign-in started here, and connects nothing", async () => {
      const accounts = all("SELECT id FROM accounts").length;
      const response = await callback("made-up-state");
      expect(response.status).toBe(303);
      expect(new URL(response.headers.get("location")!).searchParams.get("error")).toMatch(/^This sign-in was not started here/);
      expect(all("SELECT id FROM accounts")).toHaveLength(accounts);
    });

    it("still refuses a host name it does not know when there is no password", async () => {
      const route = await handler("/oauth/[platform]/callback", "GET");
      const response = await route(new Request("http://evil.example/oauth/x/callback?state=x", { headers: { host: "evil.example" } }), { params: Promise.resolve({ platform: "x" }) });
      expect(response.status).toBe(403);
    });
  });
});

/* MCP ---------------------------------------------------------------------- */

type ToolReply = { content: { text: string }[]; isError?: boolean };

async function agent(actor: () => ReturnType<typeof tokenActor>) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildServer({ baseUrl: "http://localhost:3000", local: false, actor }).connect(serverSide);
  const client = new Client({ name: "roles-test", version: "1.0.0" });
  await client.connect(clientSide);
  const tool = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolReply;
  return { client, tool };
}

describe("MCP tools check the same roles", () => {
  afterEach(() => {
    delete process.env.BROADSIDE_MCP_DRAFTS_ONLY;
    delete process.env.BROADSIDE_API_KEY;
  });
  const keyOf = (role: Role) => keys[role].authorization.slice(7);
  const as = (role: Role) => agent(() => tokenActor(keyOf(role)));
  const refusedByRole = (reply: ToolReply) => reply.isError === true && /needs the \w+ role, and this key has \w+/.test(reply.content[0].text);

  it("gives every tool a role, and the table is the one the README prints", async () => {
    expect(TOOL_ROLES).toEqual(EXPECTED_TOOLS);
    const { client } = await as("owner");
    const offered = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(offered).toEqual(Object.keys(EXPECTED_TOOLS).sort());
  });

  it("draws the line where the REST API draws it", () => {
    // A tool and the route that does the same thing ask for the same role.
    const same: [string, string, string][] = [
      ["list_accounts", "/api/v1/accounts", "GET"],
      ["disconnect_account", "/api/v1/accounts/[id]", "DELETE"],
      ["upload_media", "/api/v1/media", "POST"],
      ["list_media", "/api/v1/media", "GET"],
      ["check_post", "/api/v1/check", "POST"],
      ["create_post", "/api/v1/posts", "POST"],
      ["get_post", "/api/v1/posts/[id]", "GET"],
      ["list_posts", "/api/v1/posts", "GET"],
      ["update_post", "/api/v1/posts/[id]", "PATCH"],
      ["delete_post", "/api/v1/posts/[id]", "DELETE"],
      ["publish_post", "/api/v1/posts/[id]/publish", "POST"],
      ["cancel_post", "/api/v1/posts/[id]/cancel", "POST"],
      ["stop_series", "/api/v1/posts/[id]/cancel", "POST"],
      ["retry_target", "/api/v1/posts/[id]/targets/[targetId]/retry", "POST"],
      ["get_analytics", "/api/v1/analytics", "GET"],
      ["get_post_analytics", "/api/v1/posts/[id]/analytics", "GET"],
      ["list_feeds", "/api/v1/feeds", "GET"],
      ["list_outgoing_webhooks", "/api/v1/outgoing-webhooks", "GET"],
      ["list_tags", "/api/v1/tags", "GET"],
      ["list_groups", "/api/v1/groups", "GET"],
      ["list_signatures", "/api/v1/signatures", "GET"],
      ["list_platforms", "/api/v1/platforms", "GET"],
      ["connect_account", "/api/v1/accounts", "POST"],
    ];
    expect(same.map(([tool]) => tool).sort()).toEqual(Object.keys(EXPECTED_TOOLS).sort());
    for (const [tool, address, method] of same) expect([tool, EXPECTED_TOOLS[tool]]).toEqual([tool, EXPECTED[address][method]]);
  });

  it("walks every tool as every role: refused below its role, let through at and above it", async () => {
    const draft = await createPost({ content: "for the walk", targets: [{ account_id: sandbox }], draft: true });
    // Arguments each tool accepts, so the only thing that can stop a call is the caller's role.
    const args: Record<string, Record<string, unknown>> = {
      check_post: { content: "x", targets: [{ account_id: sandbox }] },
      get_post: { post_id: draft.id },
      get_post_analytics: { post_id: draft.id },
      upload_media: {},
      create_post: { content: "made on the walk", targets: [{ account_id: sandbox }], draft: true },
      update_post: { post_id: draft.id, content: "for the walk" },
      publish_post: { post_id: "post_missing" },
      cancel_post: { post_id: "post_missing" },
      stop_series: { post_id: "post_missing" },
      retry_target: { post_id: "post_missing", target_id: "tgt_missing" },
      delete_post: { post_id: "post_missing" },
      connect_account: { platform: "x" },
      disconnect_account: { account_id: "acc_missing" },
    };
    let walked = 0;
    for (const caller of ROLES) {
      const { tool } = await as(caller);
      for (const [name, need] of Object.entries(EXPECTED_TOOLS)) {
        const reply = await tool(name, args[name] ?? {});
        expect([caller, name, refusedByRole(reply)]).toEqual([caller, name, rank(caller) < rank(need)]);
        if (rank(caller) < rank(need)) expect(reply.content[0].text).toContain(`${name} needs the ${need} role, and this key has ${caller}.`);
        walked++;
      }
    }
    expect(walked).toBe(23 * 4);
  });

  it("lets a viewer's key list and read, and not create or publish", async () => {
    const { tool } = await as("viewer");
    const draft = await createPost({ content: "a viewer wants this out", targets: [{ account_id: sandbox }], draft: true });
    const before = all("SELECT id FROM posts").length;
    expect((await tool("list_accounts")).isError).toBeFalsy();
    expect(JSON.parse((await tool("get_post", { post_id: draft.id })).content[0].text).status).toBe("draft");
    expect((await tool("list_posts")).isError).toBeFalsy();
    for (const [name, input] of [
      ["create_post", { content: "from a viewer", targets: [{ account_id: sandbox }] }],
      ["publish_post", { post_id: draft.id }],
      ["update_post", { post_id: draft.id, content: "changed by a viewer" }],
      ["delete_post", { post_id: draft.id }],
      ["cancel_post", { post_id: draft.id }],
      ["connect_account", { platform: "sandbox" }],
    ] as const) {
      expect(refusedByRole(await tool(name, input))).toBe(true);
    }
    expect(all("SELECT id FROM posts")).toHaveLength(before);
    expect(getPost(draft.id)).toMatchObject({ status: "draft", content: "a viewer wants this out" });
  });

  it("lets an editor's key post and not touch accounts, and writes the post down as its owner's", async () => {
    const { tool } = await as("editor");
    const made = JSON.parse((await tool("create_post", { content: "from an editor's key", targets: [{ account_id: sandbox }] })).content[0].text);
    expect(made.status).toBe("published");
    expect(made.author).toEqual({ id: people.editor.id, name: "editor person" });
    const accounts = all("SELECT id FROM accounts").length;
    expect(refusedByRole(await tool("connect_account", { platform: "sandbox", name: "Sneaked" }))).toBe(true);
    expect(refusedByRole(await tool("disconnect_account", { account_id: sandbox }))).toBe(true);
    expect(all("SELECT id FROM accounts")).toHaveLength(accounts);
  });

  it("keeps drafts-only mode on top of the roles", async () => {
    process.env.BROADSIDE_MCP_DRAFTS_ONLY = "1";
    const owner = await as("owner");
    const saved = JSON.parse((await owner.tool("create_post", { content: "an owner's key, drafts only", targets: [{ account_id: sandbox }] })).content[0].text);
    expect(saved.status).toBe("draft");
    expect((await owner.tool("publish_post", { post_id: saved.id })).content[0].text).toMatch(/drafts-only mode/);
    const viewer = await as("viewer");
    expect(refusedByRole(await viewer.tool("create_post", { content: "a viewer, drafts only", targets: [{ account_id: sandbox }] }))).toBe(true);
  });

  it("asks who is calling on every call, so a change in the app holds at once", async () => {
    const owner = { id: people.owner.id, role: "owner" as const };
    const { tool } = await as("editor");
    expect(refusedByRole(await tool("create_post", { content: "one", targets: [{ account_id: sandbox }], draft: true }))).toBe(false);
    members.setRole(owner, people.editor.id, "viewer");
    expect(refusedByRole(await tool("create_post", { content: "two", targets: [{ account_id: sandbox }], draft: true }))).toBe(true);
    members.setRole(owner, people.editor.id, "editor");
    members.setDisabled(owner, people.editor.id, true);
    const dead = await tool("list_posts");
    expect(dead.isError).toBe(true);
    expect(dead.content[0].text).toMatch(/belongs to a member who can no longer sign in/);
    members.setDisabled(owner, people.editor.id, false);
    expect((await tool("list_posts")).isError).toBeFalsy();
  });

  it("runs the stdio server as an editor in a team, or as the member whose key it holds", async () => {
    // No actor passed: this is how bin/broadside-mcp.ts builds it.
    const local = async () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await buildServer({ baseUrl: "http://localhost:3000", local: true }).connect(serverSide);
      const client = new Client({ name: "roles-test-stdio", version: "1.0.0" });
      await client.connect(clientSide);
      return async (name: string, input: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: input })) as ToolReply;
    };
    const plain = await local();
    const made = JSON.parse((await plain("create_post", { content: "from the local server", targets: [{ account_id: sandbox }], draft: true })).content[0].text);
    expect(made.author).toBeNull();
    expect(refusedByRole(await plain("disconnect_account", { account_id: sandbox }))).toBe(true);
    expect((await plain("disconnect_account", { account_id: sandbox })).content[0].text).toContain("this key has editor");

    process.env.BROADSIDE_API_KEY = keyOf("viewer");
    const asViewer = await local();
    expect((await asViewer("list_posts")).isError).toBeFalsy();
    expect(refusedByRole(await asViewer("create_post", { content: "no", targets: [{ account_id: sandbox }] }))).toBe(true);

    process.env.BROADSIDE_API_KEY = keyOf("admin");
    const asAdmin = await local();
    const byAdmin = JSON.parse((await asAdmin("create_post", { content: "from an admin's local server", targets: [{ account_id: sandbox }], draft: true })).content[0].text);
    expect(byAdmin.author).toEqual({ id: people.admin.id, name: "admin person" });
  });

  it("runs the stdio server as the owner again once the team is gone", async () => {
    run("DELETE FROM oauth_pending");
    members.dissolveTeam();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await buildServer({ baseUrl: "http://localhost:3000", local: true }).connect(serverSide);
    const client = new Client({ name: "roles-test-solo", version: "1.0.0" });
    await client.connect(clientSide);
    const reply = (await client.callTool({ name: "connect_account", arguments: { platform: "sandbox", name: "Solo again" } })) as ToolReply;
    expect(reply.isError).toBeFalsy();
    expect(JSON.parse(reply.content[0].text).connected.handle).toBe("Solo again");
    // And the API is the operator's again, with the key from before the team.
    expect((await call("/api/v1/keys", "GET", { authorization: `Bearer ${oldKey}` })).status).toBe(200);
    expect((await call("/api/v1/keys", "GET", { "sec-fetch-site": "same-origin" })).status).toBe(200);
  });
});
