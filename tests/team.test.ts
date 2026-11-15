import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "broadside-team-"));
process.env.BROADSIDE_DATA_DIR = dataDir;
process.env.BROADSIDE_SECRET = "test-secret";
process.env.BROADSIDE_ALLOW_PRIVATE_FETCH = "1";
process.env.BROADSIDE_LOGIN_DELAY_MS = "40";
delete process.env.BROADSIDE_PASSWORD;
delete process.env.BROADSIDE_API_KEY;
delete process.env.BROADSIDE_PUBLIC_URL;

const { connectAccount, InputError } = await import("@/lib/accounts");
const { localActor, memberSecret, sessionActor, tokenActor, UNOWNED_KEY_ROLE } = await import("@/lib/actor");
const { all, get, migrate, run, SCHEMA } = await import("@/lib/db");
const { linkBase } = await import("@/lib/http");
const { createKey, createMemberKey, listKeys, revokeKeyAs } = await import("@/lib/keys");
const members = await import("@/lib/members");
const { finishOAuth, oauthStarter, startOAuth } = await import("@/lib/oauth");
const { createPost, getPost } = await import("@/lib/posts");
const { feedFor, webhookFor } = await import("@/lib/redact");
const { atLeast, grants, lower, manages, ROLES } = await import("@/lib/roles");
const { memberSessionValid, memberSessionValue, SESSION_COOKIE, sessionValue } = await import("@/lib/session");
const login = await import("@/app/api/login/route");
const join = await import("@/app/api/join/route");

// The real cost takes a quarter of a second a time. The tests keep the algorithm and lower the work.
members.passwordCost.N = 1024;
members.passwordCost.p = 1;

/** Long and different every run, so no test password can collide with an id or be mistaken for a real one. */
const aPassword = () => `test-${randomBytes(12).toString("hex")}`;

const withCookie = (value: string) => new Request("http://localhost/", { headers: { cookie: `${SESSION_COOKIE}=${value}` } });
const cookieFor = async (memberId: string) => memberSessionValue(memberId, memberSecret(memberId)!);
const roleNow = async (cookie: string) => (await sessionActor(withCookie(cookie)))?.role ?? null;
const post = (route: (request: Request) => Promise<Response>, body: unknown, headers: Record<string, string> = {}) => route(new Request("http://localhost/api", { method: "POST", headers: { host: "localhost", "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));

type Member = Awaited<ReturnType<typeof members.startTeam>>;
const asker = (member: Member) => ({ id: member.id, role: members.getMember(member.id)!.role });

/** Invites someone and has them join, the way the app does it. Returns the member and the password only they know. */
async function add(by: Member, name: string, role: (typeof ROLES)[number]) {
  const { token } = members.createInvite(asker(by), { name, role });
  const password = aPassword();
  return { member: await members.acceptInvite(token, password), password };
}

let sandbox: string;
let oldKey: string;

beforeAll(async () => {
  sandbox = (await connectAccount("sandbox", { name: "One" })).id;
  oldKey = createKey("from before the team").token;
});

describe("roles", () => {
  it("orders the four roles and takes the lower of two", () => {
    expect([...ROLES]).toEqual(["viewer", "editor", "admin", "owner"]);
    expect(atLeast("editor", "viewer")).toBe(true);
    expect(atLeast("editor", "editor")).toBe(true);
    expect(atLeast("editor", "admin")).toBe(false);
    expect(lower("owner", "viewer")).toBe("viewer");
    expect(lower("editor", "admin")).toBe("editor");
  });

  it("lets an owner manage anyone and an admin only editors and viewers", () => {
    for (const target of ROLES) expect(manages("owner", target)).toBe(true);
    expect(ROLES.filter((target) => manages("admin", target))).toEqual(["viewer", "editor"]);
    for (const target of ROLES) {
      expect(manages("editor", target)).toBe(false);
      expect(manages("viewer", target)).toBe(false);
    }
  });

  it("lets nobody hand out more than they have, and nobody below admin hand out anything", () => {
    expect(ROLES.filter((role) => grants("owner", role))).toEqual(["viewer", "editor", "admin", "owner"]);
    expect(ROLES.filter((role) => grants("admin", role))).toEqual(["viewer", "editor", "admin"]);
    expect(ROLES.filter((role) => grants("editor", role))).toEqual([]);
    expect(ROLES.filter((role) => grants("viewer", role))).toEqual([]);
  });
});

describe("single-user mode, before anyone is added", () => {
  it("is not a team, and everyone who was let in before is the owner", async () => {
    expect(members.teamMode()).toBe(false);
    expect(members.listMembers()).toEqual([]);
    // No password and no cookie: on this machine the operator is the owner, as before.
    expect(await sessionActor(new Request("http://localhost/"))).toEqual({ role: "owner", member: null, team: false, via: "open" });
    expect(tokenActor(oldKey)).toEqual({ role: "owner", member: null, team: false, via: "key" });
    expect(tokenActor("bs_not-a-key")).toBeNull();
    expect(localActor()).toMatchObject({ role: "owner", team: false });
  });

  it("still asks for the shared password when one is set", async () => {
    process.env.BROADSIDE_PASSWORD = "the shared one";
    expect(await sessionActor(new Request("http://localhost/"))).toBeNull();
    expect(await sessionActor(withCookie(await sessionValue()))).toEqual({ role: "owner", member: null, team: false, via: "password" });
    delete process.env.BROADSIDE_PASSWORD;
  });

  it("records no author on a post", async () => {
    const made = await createPost({ content: "before the team", targets: [{ account_id: sandbox }], draft: true });
    expect(made.author).toBeNull();
  });

  it("refuses a member's cookie shape and an invite, because there is no team to belong to", async () => {
    expect(await memberSessionValid("m1.mem_x.9999999999.00", "anything")).toBe(false);
    expect(members.peekInvite("x".repeat(43))).toBeNull();
    await expect(members.acceptInvite("x".repeat(43), aPassword())).rejects.toThrow(members.INVITE_GONE);
  });
});

describe("the schema", () => {
  it("adds the team tables and columns to an older database and keeps every row", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "broadside-preteam-")), "broadside.db");
    const old = new DatabaseSync(file);
    old.exec(SCHEMA);
    const columns = (table: string) => old.prepare(`PRAGMA table_info(${table})`).all().map((c) => String(c.name));
    expect(columns("api_keys")).not.toContain("member_id");
    old.exec("INSERT INTO posts (id, content, created_at, updated_at) VALUES ('post_old', 'from before', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')");
    old.exec("INSERT INTO api_keys (id, name, prefix, hash, created_at) VALUES ('key_old', 'CI', 'bs_abc', 'hash-of-it', '2026-01-01T00:00:00.000Z')");

    migrate(old);
    migrate(old);

    expect(columns("posts")).toContain("created_by");
    expect(columns("api_keys")).toEqual(expect.arrayContaining(["member_id", "role"]));
    expect(columns("members")).toEqual(expect.arrayContaining(["id", "name", "name_key", "role", "password_hash", "created_at", "disabled_at", "last_seen_at"]));
    expect(columns("invites")).toEqual(expect.arrayContaining(["id", "token_hash", "role", "name", "created_by", "expires_at", "used_at"]));
    expect({ ...old.prepare("SELECT content, created_by FROM posts WHERE id = 'post_old'").get() }).toEqual({ content: "from before", created_by: null });
    expect({ ...old.prepare("SELECT name, hash, member_id, role FROM api_keys WHERE id = 'key_old'").get() }).toEqual({ name: "CI", hash: "hash-of-it", member_id: null, role: null });
    expect(old.prepare("SELECT COUNT(*) AS n FROM members").get()!.n).toBe(0);
    old.close();
  });
});

describe("passwords", () => {
  it("are hashed with scrypt, a salt of their own and the cost written beside the hash", async () => {
    const password = aPassword();
    const [first, second] = [await members.hashPassword(password), await members.hashPassword(password)];
    const [scheme, N, r, p, salt, hash] = first.split("$");
    expect([scheme, N, r, p]).toEqual(["scrypt", "1024", "8", "1"]);
    expect(Buffer.from(salt, "base64url")).toHaveLength(16);
    expect(Buffer.from(hash, "base64url")).toHaveLength(32);
    expect(first).not.toBe(second);
    expect(first).not.toContain(password);
    expect(await members.passwordMatches(password, first)).toBe(true);
    expect(await members.passwordMatches(`${password}x`, first)).toBe(false);
    expect(await members.passwordMatches(password, second)).toBe(true);
  });

  it("are checked with the cost a hash was made with, so raising the cost later breaks nothing", async () => {
    const password = aPassword();
    const made = await members.hashPassword(password);
    members.passwordCost.N = 2048;
    expect(await members.passwordMatches(password, made)).toBe(true);
    expect((await members.hashPassword(password)).split("$")[1]).toBe("2048");
    members.passwordCost.N = 1024;
  });

  it("match nothing when there is no usable hash", async () => {
    expect(await members.passwordMatches(aPassword(), null)).toBe(false);
    expect(await members.passwordMatches(aPassword(), "reset$abc")).toBe(false);
    expect(await members.passwordMatches("", "")).toBe(false);
  });

  it("must be 12 to 200 characters", () => {
    expect(() => members.checkPassword("eleven-char")).toThrow("A password needs at least 12 characters. This one has 11.");
    expect(members.checkPassword("twelve-chars")).toBe("twelve-chars");
    expect(members.checkPassword("x".repeat(200))).toHaveLength(200);
    expect(() => members.checkPassword("x".repeat(201))).toThrow("A password can be 200 characters at most.");
    expect(() => members.checkPassword(undefined)).toThrow("Choose a password.");
    expect(() => members.checkPassword(12345678901234)).toThrow("Choose a password.");
  });
});

describe("starting a team", () => {
  let owner: Member;
  let ownerPassword: string;

  it("refuses a weak password or an empty name, and stays single-user", async () => {
    await expect(members.startTeam({ name: "Ada", password: "short" })).rejects.toThrow(/at least 12 characters/);
    await expect(members.startTeam({ name: "   ", password: aPassword() })).rejects.toThrow("Give the member a name.");
    await expect(members.startTeam({ name: "x".repeat(41), password: aPassword() })).rejects.toThrow("A name can be 40 characters at most.");
    expect(members.teamMode()).toBe(false);
  });

  it("makes exactly one owner when two people set up a team at the same moment", async () => {
    ownerPassword = aPassword();
    const results = await Promise.allSettled([members.startTeam({ name: "  Ada   Lovelace ", password: ownerPassword }), members.startTeam({ name: "Mallory", password: ownerPassword })]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(InputError);
    expect((lost[0] as PromiseRejectedResult).reason.message).toBe("This Broadside already has a team. Sign in as a member.");
    expect(members.listMembers()).toHaveLength(1);
    owner = members.listMembers()[0];
    expect(owner.role).toBe("owner");
    expect(members.teamMode()).toBe(true);
    await expect(members.startTeam({ name: "Again", password: aPassword() })).rejects.toThrow("already has a team");
  });

  it("never stores a password, and keeps the name tidy", async () => {
    if (owner.name !== "Ada Lovelace") {
      // Mallory won the race above. Either is a fair outcome; the rest of the file only needs one owner.
      expect(owner.name).toBe("Mallory");
    }
    const row = get<{ password_hash: string }>("SELECT password_hash FROM members WHERE id = ?", owner.id)!;
    expect(row.password_hash).toMatch(/^scrypt\$/);
    expect(JSON.stringify(all("SELECT * FROM members"))).not.toContain(ownerPassword);
    expect(JSON.stringify(members.listMembers())).not.toContain("scrypt");
  });

  it("ends single-user access: no cookie, the shared password's cookie and a guess all sign no one in", async () => {
    expect(await sessionActor(new Request("http://localhost/"))).toBeNull();
    process.env.BROADSIDE_PASSWORD = "the shared one";
    // This cookie is exactly what the shared password earned a moment ago.
    expect(await sessionActor(withCookie(await sessionValue()))).toBeNull();
    delete process.env.BROADSIDE_PASSWORD;
    expect(await sessionActor(withCookie("m1.mem_nobody.9999999999.00"))).toBeNull();
    expect(await sessionActor(withCookie(`m1.${owner.id}.9999999999.${"0".repeat(64)}`))).toBeNull();
  });

  it("signs the owner in by name and password, whatever the capitals or spacing of the name", async () => {
    expect(await members.signIn(owner.name, ownerPassword)).toMatchObject({ id: owner.id });
    expect(await members.signIn(`  ${owner.name.toUpperCase()}  `, ownerPassword)).toMatchObject({ id: owner.id });
    expect(await members.signIn(owner.name, `${ownerPassword}!`)).toBeNull();
    expect(await members.signIn("Nobody here", ownerPassword)).toBeNull();
    expect(await members.signIn(undefined, undefined)).toBeNull();
  });
});

describe("sessions", () => {
  let owner: Member;
  beforeAll(() => {
    owner = members.listMembers().find((m) => m.role === "owner")!;
  });

  it("belong to one member, expire, and cannot be forged or moved to another member", async () => {
    const cookie = await cookieFor(owner.id);
    expect(cookie).toMatch(new RegExp(`^m1\\.${owner.id}\\.\\d+\\.[0-9a-f]{64}$`));
    expect(await sessionActor(withCookie(cookie))).toEqual({ role: "owner", member: { id: owner.id, name: owner.name }, via: "session", team: true });
    expect(await sessionActor(withCookie(cookie), Date.now() + 31 * 24 * 3600_000)).toBeNull();
    const [, , expires, signature] = cookie.split(".");
    expect(await sessionActor(withCookie(`m1.${owner.id}.${Number(expires) + 60}.${signature}`))).toBeNull();
    const { member: other } = await add(owner, "Session Other", "viewer");
    expect(await sessionActor(withCookie(`m1.${other.id}.${expires}.${signature}`))).toBeNull();
    expect(await sessionActor(withCookie(`${cookie}.extra`))).toBeNull();
  });

  it("carry no role: a role changed in the database holds from the next request", async () => {
    const { member } = await add(owner, "Promoted Later", "viewer");
    const cookie = await cookieFor(member.id);
    expect(cookie).not.toMatch(/viewer|editor|admin|owner/);
    expect(await roleNow(cookie)).toBe("viewer");
    members.setRole(asker(owner), member.id, "admin");
    expect(await roleNow(cookie)).toBe("admin");
    members.setRole(asker(owner), member.id, "editor");
    expect(await roleNow(cookie)).toBe("editor");
  });

  it("end everywhere when the member changes their password", async () => {
    const { member, password } = await add(owner, "Changes Password", "editor");
    const before = await cookieFor(member.id);
    expect(await roleNow(before)).toBe("editor");
    const next = aPassword();
    await expect(members.changePassword(member.id, "not the current one", next)).rejects.toThrow("That is not your current password.");
    await expect(members.changePassword(member.id, password, "too short")).rejects.toThrow(/at least 12 characters/);
    await expect(members.changePassword(member.id, password, password)).rejects.toThrow("The new password is the same as the current one.");
    expect(await roleNow(before)).toBe("editor");
    await members.changePassword(member.id, password, next);
    expect(await roleNow(before)).toBeNull();
    expect(await roleNow(await cookieFor(member.id))).toBe("editor");
    expect(await members.signIn(member.name, password)).toBeNull();
    expect(await members.signIn(member.name, next)).toMatchObject({ id: member.id });
  });

  it("end when the member is disabled, and stay ended if they are enabled again", async () => {
    const { member, password } = await add(owner, "Gets Disabled", "editor");
    const before = await cookieFor(member.id);
    expect(await roleNow(before)).toBe("editor");
    members.setDisabled(asker(owner), member.id, true);
    expect(await roleNow(before)).toBeNull();
    expect(memberSecret(member.id)).toBeNull();
    expect(await members.signIn(member.name, password)).toBeNull();
    members.setDisabled(asker(owner), member.id, false);
    expect(await roleNow(before)).toBeNull();
    expect(await members.signIn(member.name, password)).toMatchObject({ id: member.id });
    expect(await roleNow(await cookieFor(member.id))).toBe("editor");
  });

  it("end when the server secret changes", async () => {
    const cookie = await cookieFor(owner.id);
    process.env.BROADSIDE_SECRET = "another-secret";
    expect(await roleNow(cookie)).toBeNull();
    process.env.BROADSIDE_SECRET = "test-secret";
    expect(await roleNow(cookie)).toBe("owner");
  });
});

describe("invites", () => {
  let owner: Member;
  let admin: Member;
  let editor: Member;
  beforeAll(async () => {
    owner = members.listMembers().find((m) => m.role === "owner")!;
    admin = (await add(owner, "Invite Admin", "admin")).member;
    editor = (await add(owner, "Invite Editor", "editor")).member;
  });

  it("carry at least 32 random bytes, and only a hash of them is stored", () => {
    const { token, invite } = members.createInvite(asker(owner), { name: "Token Check", role: "viewer" });
    expect(Buffer.from(token, "base64url").length).toBeGreaterThanOrEqual(32);
    expect(JSON.stringify(all("SELECT * FROM invites"))).not.toContain(token);
    expect(JSON.stringify(invite)).not.toContain(token);
    expect(JSON.stringify(members.listInvites())).not.toContain(token);
    expect(new Date(invite.expires_at).getTime() - Date.now()).toBeGreaterThan(6.9 * 24 * 3600_000);
    expect(new Date(invite.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(7 * 24 * 3600_000);
    members.revokeInvite(asker(owner), invite.id);
  });

  it("are for a role no higher than the inviter's own", () => {
    expect(() => members.createInvite(asker(admin), { name: "Too High", role: "owner" })).toThrow("You can invite someone with a role up to your own, which is admin.");
    expect(() => members.createInvite(asker(editor), { name: "Not Mine To Give", role: "viewer" })).toThrow("Inviting someone needs an admin.");
    expect(() => members.createInvite(asker(owner), { name: "Odd", role: "superuser" })).toThrow("A role is one of viewer, editor, admin or owner.");
    const fine = members.createInvite(asker(admin), { name: "Peer Admin", role: "admin" });
    expect(fine.invite.role).toBe("admin");
    members.revokeInvite(asker(admin), fine.invite.id);
  });

  it("go by the role the inviter has now, not the one a caller claims", () => {
    // The editor says they are an owner. The database says otherwise, and the database is what counts.
    expect(() => members.createInvite({ id: editor.id, role: "owner" }, { name: "Smuggled", role: "owner" })).toThrow("Inviting someone needs an admin.");
    expect(() => members.createInvite({ id: "mem_nobody", role: "owner" }, { name: "Smuggled", role: "viewer" })).toThrow("You are no longer a member of this Broadside.");
  });

  it("refuse a name that is taken, whatever its capitals or spacing", async () => {
    expect(() => members.createInvite(asker(owner), { name: "  invite   EDITOR ", role: "viewer" })).toThrow(/There is already a member called invite EDITOR/);
    const first = members.createInvite(asker(owner), { name: "Twice Invited", role: "viewer" });
    expect(() => members.createInvite(asker(owner), { name: "twice  invited", role: "viewer" })).toThrow(/There is already an invite waiting for twice invited/);
    members.revokeInvite(asker(owner), first.invite.id);
    expect(members.createInvite(asker(owner), { name: "twice invited", role: "viewer" }).invite.name).toBe("twice invited");
  });

  it("work once: the person sets their own password, becomes a member, and the link is dead", async () => {
    const { token } = members.createInvite(asker(admin), { name: "Joins Once", role: "editor" });
    expect(members.peekInvite(token)).toEqual({ name: "Joins Once", role: "editor", reset: false });
    await expect(members.acceptInvite(token, "too short")).rejects.toThrow(/at least 12 characters/);
    expect(members.peekInvite(token)).not.toBeNull();
    const password = aPassword();
    const joined = await members.acceptInvite(token, password);
    expect(joined).toMatchObject({ name: "Joins Once", role: "editor", disabled_at: null });
    expect(members.peekInvite(token)).toBeNull();
    await expect(members.acceptInvite(token, aPassword())).rejects.toThrow(members.INVITE_GONE);
    expect(await members.signIn("joins once", password)).toMatchObject({ id: joined.id });
    expect(members.listMembers().filter((m) => m.name === "Joins Once")).toHaveLength(1);
  });

  it("make one member when the same link is opened twice at the same moment", async () => {
    const { token } = members.createInvite(asker(owner), { name: "Raced Link", role: "viewer" });
    const results = await Promise.allSettled([members.acceptInvite(token, aPassword()), members.acceptInvite(token, aPassword()), members.acceptInvite(token, aPassword())]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(members.listMembers().filter((m) => m.name === "Raced Link")).toHaveLength(1);
  });

  it("run out after seven days", async () => {
    const { token, invite } = members.createInvite(asker(owner), { name: "Too Late", role: "viewer" });
    run("UPDATE invites SET expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), invite.id);
    expect(members.peekInvite(token)).toBeNull();
    await expect(members.acceptInvite(token, aPassword())).rejects.toThrow(members.INVITE_GONE);
    expect(members.listInvites().some((i) => i.id === invite.id)).toBe(false);
    expect(members.findMemberByName("Too Late")).toBeUndefined();
  });

  it("stop working when revoked, and a guess opens nothing", async () => {
    const { token, invite } = members.createInvite(asker(owner), { name: "Withdrawn", role: "viewer" });
    members.revokeInvite(asker(owner), invite.id);
    await expect(members.acceptInvite(token, aPassword())).rejects.toThrow(members.INVITE_GONE);
    for (const guess of ["", "short", randomBytes(32).toString("base64url"), "x".repeat(500), null, 42, { token }]) {
      expect(members.peekInvite(guess)).toBeNull();
      await expect(members.acceptInvite(guess, aPassword())).rejects.toThrow(members.INVITE_GONE);
    }
  });

  it("are withdrawn when whoever made them is demoted, disabled or removed", async () => {
    const leaving = (await add(owner, "Leaving Admin", "admin")).member;
    const forAdmin = members.createInvite(asker(leaving), { name: "Door Left Open", role: "admin" });
    const forViewer = members.createInvite(asker(leaving), { name: "Small Door", role: "viewer" });
    members.setRole(asker(owner), leaving.id, "editor");
    // An editor cannot invite anyone, so neither invite outlives the demotion.
    expect(members.peekInvite(forAdmin.token)).toBeNull();
    expect(members.peekInvite(forViewer.token)).toBeNull();
    members.setRole(asker(owner), leaving.id, "admin");
    const again = members.createInvite(asker(leaving), { name: "Door Left Open", role: "admin" });
    members.setDisabled(asker(owner), leaving.id, true);
    await expect(members.acceptInvite(again.token, aPassword())).rejects.toThrow(members.INVITE_GONE);
    members.setDisabled(asker(owner), leaving.id, false);
    const last = members.createInvite(asker(leaving), { name: "Door Left Open", role: "viewer" });
    members.setDisabled(asker(owner), leaving.id, true);
    members.removeMember(asker(owner), leaving.id);
    expect(members.peekInvite(last.token)).toBeNull();
    expect(members.findMemberByName("Door Left Open")).toBeUndefined();
  });

  it("can only be revoked by someone who could have made them", () => {
    const forOwner = members.createInvite(asker(owner), { name: "Second Owner", role: "owner" });
    expect(() => members.revokeInvite(asker(admin), forOwner.invite.id)).toThrow("You can revoke invites for roles up to your own, which is admin.");
    expect(() => members.revokeInvite(asker(editor), forOwner.invite.id)).toThrow();
    members.revokeInvite(asker(owner), forOwner.invite.id);
    expect(() => members.revokeInvite(asker(owner), forOwner.invite.id)).toThrow("That invite is gone already.");
  });
});

describe("changing members", () => {
  let owner: Member;
  let admin: Member;
  let otherAdmin: Member;
  let editor: Member;
  let viewer: Member;
  beforeAll(async () => {
    owner = members.listMembers().find((m) => m.role === "owner")!;
    admin = (await add(owner, "Manage Admin", "admin")).member;
    otherAdmin = (await add(owner, "Manage Other Admin", "admin")).member;
    editor = (await add(owner, "Manage Editor", "editor")).member;
    viewer = (await add(owner, "Manage Viewer", "viewer")).member;
  });
  const role = (member: Member) => members.getMember(member.id)!.role;

  it("stops an admin touching an owner or another admin", () => {
    expect(() => members.setRole(asker(admin), owner.id, "viewer")).toThrow(/needs an owner/);
    expect(() => members.setDisabled(asker(admin), owner.id, true)).toThrow(/needs an owner/);
    expect(() => members.removeMember(asker(admin), owner.id)).toThrow(/needs an owner/);
    expect(() => members.setRole(asker(admin), otherAdmin.id, "viewer")).toThrow(/needs an owner/);
    expect(() => members.setDisabled(asker(admin), otherAdmin.id, true)).toThrow(/needs an owner/);
    expect(() => members.removeMember(asker(admin), otherAdmin.id)).toThrow(/needs an owner/);
    expect(role(owner)).toBe("owner");
    expect(role(otherAdmin)).toBe("admin");
    expect(members.getMember(owner.id)!.disabled_at).toBeNull();
  });

  it("stops anyone raising, lowering or disabling themselves", () => {
    expect(() => members.setRole(asker(admin), admin.id, "owner")).toThrow("You cannot change your own role. Ask another owner.");
    expect(() => members.setRole(asker(editor), editor.id, "admin")).toThrow("You cannot change your own role. Ask another owner.");
    expect(() => members.setRole(asker(owner), owner.id, "viewer")).toThrow("You cannot change your own role. Ask another owner.");
    expect(() => members.setDisabled(asker(owner), owner.id, true)).toThrow("You cannot disable yourself. Ask another owner.");
    expect(() => members.removeMember(asker(owner), owner.id)).toThrow("You cannot remove yourself. Ask another owner.");
    expect(role(admin)).toBe("admin");
  });

  it("lets an admin change editors and viewers, up to admin and no further", () => {
    expect(members.setRole(asker(admin), viewer.id, "editor").role).toBe("editor");
    expect(() => members.setRole(asker(admin), viewer.id, "owner")).toThrow("You can give a role up to your own, which is admin.");
    expect(role(viewer)).toBe("editor");
    expect(members.setRole(asker(admin), viewer.id, "viewer").role).toBe("viewer");
    expect(() => members.setRole(asker(admin), viewer.id, "root")).toThrow("A role is one of viewer, editor, admin or owner.");
  });

  it("gives editors and viewers no say over anyone", () => {
    expect(() => members.setRole(asker(editor), viewer.id, "editor")).toThrow(/needs an admin/);
    expect(() => members.setDisabled(asker(editor), viewer.id, true)).toThrow(/needs an admin/);
    expect(() => members.removeMember(asker(viewer), editor.id)).toThrow(/needs an admin/);
    // Claiming a role changes nothing: it is read from the database.
    expect(() => members.setRole({ id: editor.id, role: "owner" }, viewer.id, "admin")).toThrow(/needs an admin/);
  });

  it("holds a demoted admin to their new role at once", () => {
    members.setRole(asker(owner), otherAdmin.id, "editor");
    expect(() => members.setRole({ id: otherAdmin.id, role: "admin" }, viewer.id, "editor")).toThrow(/needs an admin/);
    expect(() => members.createInvite({ id: otherAdmin.id, role: "admin" }, { name: "From A Demoted Admin", role: "viewer" })).toThrow("Inviting someone needs an admin.");
    members.setRole(asker(owner), otherAdmin.id, "admin");
  });

  it("always keeps one owner who can sign in", async () => {
    const second = (await add(owner, "Second Owner Here", "owner")).member;
    // With two owners, either can be demoted or disabled by the other...
    expect(members.setDisabled(asker(owner), second.id, true).disabled_at).not.toBeNull();
    // ...and a disabled owner does not count as the one who must remain.
    expect(() => members.setRole(asker(second), owner.id, "admin")).toThrow("You are no longer a member of this Broadside.");
    members.setDisabled(asker(owner), second.id, false);
    expect(members.setRole(asker(second), owner.id, "admin").role).toBe("admin");
    // Now `second` is the only owner. Nobody can take that away: not an admin, and not themselves.
    expect(() => members.setRole(asker(owner), second.id, "admin")).toThrow(/needs an owner/);
    expect(() => members.setRole(asker(second), second.id, "admin")).toThrow("You cannot change your own role. Ask another owner.");
    expect(() => members.disableMemberByName("Second Owner Here")).toThrow(/is the only owner/);
    // Put things back: the first owner is an owner again, and removes the second.
    members.setRole(asker(second), owner.id, "owner");
    members.setRole(asker(owner), second.id, "viewer");
    expect(() => members.setRole(asker(second), owner.id, "viewer")).toThrow(/needs an owner/);
    members.setDisabled(asker(owner), second.id, true);
    members.removeMember(asker(owner), second.id);
    expect(members.getMember(second.id)).toBeUndefined();
    expect(members.listMembers().filter((m) => m.role === "owner" && !m.disabled_at)).toHaveLength(1);
  });

  it("refuses to demote, disable or remove the last owner, from the app or the server", async () => {
    const lone = members.listMembers().filter((m) => m.role === "owner" && !m.disabled_at);
    expect(lone).toHaveLength(1);
    // A second owner who is disabled must not make the first one removable.
    const spare = (await add(owner, "Disabled Spare Owner", "owner")).member;
    members.setDisabled(asker(owner), spare.id, true);
    expect(() => members.setRole(asker(spare), owner.id, "viewer")).toThrow("You are no longer a member of this Broadside.");
    expect(() => members.disableMemberByName(owner.name)).toThrow(/is the only owner/);
    expect(role(owner)).toBe("owner");
    members.removeMember(asker(owner), spare.id);
  });

  it("removes a member with their keys, and leaves their posts without a name", async () => {
    const { member } = await add(owner, "Leaves Soon", "admin");
    const key = createMemberKey({ id: member.id, role: "admin" }, "theirs", "editor");
    const made = await createPost({ content: "by someone who leaves", targets: [{ account_id: sandbox }], draft: true }, fetch, { created_by: member.id });
    expect(made.author).toEqual({ id: member.id, name: "Leaves Soon" });
    members.removeMember(asker(owner), member.id);
    expect(tokenActor(key.token)).toBeNull();
    expect(listKeys().some((k) => k.id === key.key.id)).toBe(false);
    expect(getPost(made.id)!.author).toEqual({ id: member.id, name: null });
  });
});

describe("API keys", () => {
  let owner: Member;
  let admin: Member;
  let editor: Member;
  beforeAll(async () => {
    owner = members.listMembers().find((m) => m.role === "owner")!;
    admin = (await add(owner, "Key Admin", "admin")).member;
    editor = (await add(owner, "Key Editor", "editor")).member;
  });

  it("belong to their maker and carry a role no higher than the maker's", () => {
    const { key, token } = createMemberKey(asker(admin), "agent", "editor");
    expect(key).toMatchObject({ member_id: admin.id, role: "editor" });
    expect(tokenActor(token)).toEqual({ role: "editor", member: { id: admin.id, name: "Key Admin" }, via: "key", team: true });
    expect(createMemberKey(asker(admin), "default", undefined).key.role).toBe("admin");
    expect(() => createMemberKey(asker(admin), "too much", "owner")).toThrow("A key can have a role up to your own, which is admin.");
    expect(() => createMemberKey(asker(editor), "an editor wants an admin key", "admin")).toThrow("A key can have a role up to your own, which is editor.");
    expect(() => createMemberKey(asker(admin), "odd", "root")).toThrow("A key's role is one of viewer, editor, admin or owner.");
  });

  it("can do the lower of their own role and their owner's role now", () => {
    const { token } = createMemberKey(asker(admin), "tracks its owner", "admin");
    expect(tokenActor(token)!.role).toBe("admin");
    members.setRole(asker(owner), admin.id, "viewer");
    expect(tokenActor(token)!.role).toBe("viewer");
    members.setRole(asker(owner), admin.id, "owner");
    // Promoting the owner never lifts the key above the role it was made with.
    expect(tokenActor(token)!.role).toBe("admin");
    members.setRole(asker(owner), admin.id, "admin");
  });

  it("stop working when their owner is disabled, and work again only if the owner is enabled", () => {
    const { token } = createMemberKey(asker(admin), "dies with its owner", "editor");
    members.setDisabled(asker(owner), admin.id, true);
    expect(tokenActor(token)).toBeNull();
    members.setDisabled(asker(owner), admin.id, false);
    expect(tokenActor(token)!.role).toBe("editor");
  });

  it("from before the team work as an editor that belongs to no one", () => {
    expect(UNOWNED_KEY_ROLE).toBe("editor");
    expect(tokenActor(oldKey)).toEqual({ role: "editor", member: null, via: "key", team: true });
    const listed = listKeys().find((k) => k.name === "from before the team")!;
    expect(listed).toMatchObject({ member_id: null, role: null });
  });

  it("set in the environment work as an editor that belongs to no one", () => {
    process.env.BROADSIDE_API_KEY = `bs_${randomBytes(24).toString("base64url")}`;
    expect(tokenActor(process.env.BROADSIDE_API_KEY)).toEqual({ role: "editor", member: null, via: "key", team: true });
    delete process.env.BROADSIDE_API_KEY;
  });

  it("are revoked by their owner, by an owner, and by an admin only below admin", () => {
    const ofOwner = createMemberKey(asker(owner), "owner's", "viewer");
    const ofEditor = createMemberKey({ id: editor.id, role: "editor" }, "editor's", "viewer");
    const ofAdmin = createMemberKey(asker(admin), "admin's own", "viewer");
    expect(() => revokeKeyAs(asker(admin), ofOwner.key.id)).toThrow(/belongs to .*\. Revoking it needs an owner\./);
    expect(tokenActor(ofOwner.token)).not.toBeNull();
    expect(revokeKeyAs(asker(admin), ofEditor.key.id)).toBe(true);
    expect(revokeKeyAs(asker(admin), ofAdmin.key.id)).toBe(true);
    expect(revokeKeyAs(asker(owner), ofOwner.key.id)).toBe(true);
    expect(revokeKeyAs(asker(owner), "key_missing")).toBe(false);
    const spare = createKey("another from before").key;
    run("UPDATE api_keys SET member_id = NULL, role = NULL WHERE id = ?", spare.id);
    expect(revokeKeyAs(asker(admin), spare.id)).toBe(true);
  });

  it("run the stdio server as an editor in a team, or as the member whose key it is given", () => {
    expect(localActor()).toEqual({ role: "editor", member: null, via: "key", team: true });
    const viewerKey = createMemberKey(asker(admin), "for the local server", "viewer");
    process.env.BROADSIDE_API_KEY = viewerKey.token;
    expect(localActor()).toEqual({ role: "viewer", member: { id: admin.id, name: "Key Admin" }, via: "key", team: true });
    members.setDisabled(asker(owner), admin.id, true);
    expect(localActor()).toBeNull();
    members.setDisabled(asker(owner), admin.id, false);
    delete process.env.BROADSIDE_API_KEY;
  });
});

describe("who wrote a post", () => {
  it("is recorded from who is asking, and never for a feed's post", async () => {
    const owner = members.listMembers().find((m) => m.role === "owner")!;
    const mine = await createPost({ content: "written by a member", targets: [{ account_id: sandbox }], draft: true }, fetch, { created_by: owner.id });
    expect(mine.author).toEqual({ id: owner.id, name: owner.name });
    const fromFeed = await createPost({ content: "written by a feed", targets: [{ account_id: sandbox }], draft: true }, fetch, { created_by: owner.id, feed_id: "feed_x" });
    expect(fromFeed.author).toBeNull();
    // A request body cannot name an author: the field is not part of what a post is made from.
    const smuggled = await createPost({ content: "claims an author", targets: [{ account_id: sandbox }], draft: true, created_by: owner.id } as Parameters<typeof createPost>[0]);
    expect(smuggled.author).toBeNull();
  });

  it("stays with a repeating post's next occurrence", async () => {
    const owner = members.listMembers().find((m) => m.role === "owner")!;
    const first = await createPost({ content: "every day", targets: [{ account_id: sandbox }], publish_at: new Date(Date.now() + 1500).toISOString(), repeat: { every: "day" } }, fetch, { created_by: owner.id });
    const { tick } = await import("@/lib/scheduler");
    run("UPDATE posts SET publish_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), first.id);
    await tick();
    const next = all<{ id: string; created_by: string | null }>("SELECT id, created_by FROM posts WHERE series_id = ? AND id <> ?", first.series!.id, first.id);
    expect(next).toHaveLength(1);
    expect(next[0].created_by).toBe(owner.id);
  });
});

describe("signing in over HTTP", () => {
  let member: Member;
  let password: string;
  beforeAll(async () => {
    const owner = members.listMembers().find((m) => m.role === "owner")!;
    ({ member, password } = await add(owner, "Http Login", "editor"));
  });

  it("answers a wrong name and a wrong password with the same status and the same words", async () => {
    const wrongPassword = await post(login.POST, { name: "Http Login", password: aPassword() });
    const wrongName = await post(login.POST, { name: "Nobody Called This", password });
    const nothing = await post(login.POST, {});
    const disabledLike = await post(login.POST, { name: "Http Login" });
    expect(wrongPassword.status).toBe(401);
    const text = await wrongPassword.text();
    for (const other of [wrongName, nothing, disabledLike]) {
      expect(other.status).toBe(401);
      expect(await other.text()).toBe(text);
      expect(other.headers.get("set-cookie")).toBeNull();
    }
    expect(text).toBe(JSON.stringify({ error: { code: "wrong_password", message: "That name and password do not match a member of this Broadside." } }));
  });

  it("does the same work for a name nobody has as for a real one", async () => {
    // Enough work to measure. A name that is not checked at all would answer in well under a millisecond.
    members.passwordCost.N = 16384;
    members.passwordCost.p = 2;
    const timed = async (name: string) => {
      const started = performance.now();
      await members.signIn(name, aPassword());
      return performance.now() - started;
    };
    const known = await timed("Http Login");
    const unknown = await timed("Nobody Called This");
    members.passwordCost.N = 1024;
    members.passwordCost.p = 1;
    expect(unknown).toBeGreaterThan(8);
    expect(unknown).toBeGreaterThan(known / 20);
  });

  it("starts a session for the right name and password, with the same cookie flags as before", async () => {
    const response = await post(login.POST, { name: "  http LOGIN ", password });
    expect(response.status).toBe(200);
    const header = response.headers.get("set-cookie")!;
    expect(header).toMatch(new RegExp(`^${SESSION_COOKIE}=m1\\.${member.id}\\.\\d+\\.[0-9a-f]{64}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000$`));
    expect(await roleNow(header.split(";")[0].slice(SESSION_COOKIE.length + 1))).toBe("editor");
    const overHttps = await login.POST(new Request("https://post.example/api/login", { method: "POST", body: JSON.stringify({ name: "Http Login", password }) }));
    expect(overHttps.headers.get("set-cookie")).toMatch(/; Secure$/);
    expect(JSON.stringify(await response.json())).not.toContain(password);
  });

  it("refuses the shared password, a sign-in posted from another site, and a disabled member", async () => {
    process.env.BROADSIDE_PASSWORD = "the shared one";
    expect((await post(login.POST, { password: "the shared one" })).status).toBe(401);
    expect((await post(login.POST, { name: "Http Login", password: "the shared one" })).status).toBe(401);
    delete process.env.BROADSIDE_PASSWORD;
    expect((await post(login.POST, { name: "Http Login", password }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    const owner = members.listMembers().find((m) => m.role === "owner")!;
    members.setDisabled(asker(owner), member.id, true);
    const refused = await post(login.POST, { name: "Http Login", password });
    expect(refused.status).toBe(401);
    expect((await refused.json()).error.message).toBe("That name and password do not match a member of this Broadside.");
    members.setDisabled(asker(owner), member.id, false);
  });

  it("slows guesses at one name and never locks the member out", async () => {
    const owner = members.listMembers().find((m) => m.role === "owner")!;
    const target = await add(owner, "Guessed At", "viewer");
    const elapsed = async (body: unknown) => {
      const started = performance.now();
      const response = await post(login.POST, body);
      return { ms: performance.now() - started, status: response.status };
    };
    for (let i = 0; i < 5; i++) expect((await elapsed({ name: "Guessed At", password: aPassword() })).status).toBe(401);
    const sixth = await elapsed({ name: "guessed at", password: aPassword() });
    expect(sixth.status).toBe(401);
    expect(sixth.ms).toBeGreaterThanOrEqual(35);
    // The right password waits its turn and still gets in.
    const right = await elapsed({ name: "Guessed At", password: target.password });
    expect(right.status).toBe(200);
    expect(right.ms).toBeGreaterThanOrEqual(35);
  });
});

describe("joining over HTTP", () => {
  it("sets the invited person's password, signs them in, and works once", async () => {
    const owner = members.listMembers().find((m) => m.role === "owner")!;
    const { token } = members.createInvite(asker(owner), { name: "Http Join", role: "viewer" });
    const password = aPassword();
    expect((await post(join.POST, { token, password }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    // With no password on the install, a host name it does not know is refused here as everywhere else.
    expect((await post(join.POST, { token, password }, { host: "evil.example" })).status).toBe(403);
    expect((await post(join.POST, { token, password: "too short" })).status).toBe(400);
    const joined = await post(join.POST, { token, password });
    expect(joined.status).toBe(200);
    const body = await joined.json();
    expect(body.data).toEqual({ signed_in: true, name: "Http Join", role: "viewer" });
    expect(JSON.stringify(body)).not.toContain(token);
    const cookie = joined.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly; SameSite=Lax/);
    expect(await roleNow(cookie.split(";")[0].slice(SESSION_COOKIE.length + 1))).toBe("viewer");
    const again = await post(join.POST, { token, password: aPassword() });
    expect(again.status).toBe(400);
    expect((await again.json()).error.message).toBe(members.INVITE_GONE);
    expect((await post(join.POST, { token: randomBytes(32).toString("base64url"), password })).status).toBe(400);
    expect((await post(join.POST, {})).status).toBe(400);
  });
});

describe("links for other people", () => {
  afterEach(() => {
    delete process.env.BROADSIDE_PUBLIC_URL;
    delete process.env.BROADSIDE_PASSWORD;
  });
  const from = (host: string) => new Request(`http://${host}/api/v1/team/invites`, { headers: { host } });

  it("use the configured address, or a host name this Broadside knows as its own, and nothing else", () => {
    expect(linkBase(from("localhost:3000"))).toBe("http://localhost:3000");
    expect(linkBase(from("evil.example"))).toBeNull();
    // With a password set every host name is answered, but a link is still not built from one nothing has checked.
    process.env.BROADSIDE_PASSWORD = "the shared one";
    expect(linkBase(from("evil.example"))).toBeNull();
    process.env.BROADSIDE_PUBLIC_URL = "https://post.example.com/";
    expect(linkBase(from("evil.example"))).toBe("https://post.example.com");
  });
});

describe("what is shown below admin", () => {
  it("leaves out the part of a feed or receiver address that could hold a token", () => {
    const feed = { url: "https://blog.example/feed.xml?token=abc123", title: "Blog" };
    const hook = { url: "https://hooks.example/catch/abc123/def456?key=1", name: "Zap" };
    expect(feedFor("admin", feed)).toBe(feed);
    expect(feedFor("owner", feed)).toBe(feed);
    expect(webhookFor("admin", hook)).toBe(hook);
    for (const role of ["viewer", "editor"] as const) {
      expect(feedFor(role, feed)).toEqual({ url: "https://blog.example/feed.xml", title: "Blog", redacted: true });
      expect(webhookFor(role, hook)).toEqual({ url: "https://hooks.example", name: "Zap", redacted: true });
      expect(JSON.stringify([feedFor(role, feed), webhookFor(role, hook)])).not.toMatch(/abc123|def456|key=1/);
    }
  });
});

describe("a sign-in with a network", () => {
  const net = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("oauth2/token")) return Response.json({ token_type: "bearer", access_token: "at", refresh_token: "rt", expires_in: 7200, scope: "tweet.read" });
    if (url.includes("/2/users/me")) return Response.json({ data: { id: "1", username: "tester" } });
    return Response.json({});
  }) as typeof fetch;
  const begin = (starter: Parameters<typeof startOAuth>[3]) => new URL(startOAuth("x", { client_id: "id", client_secret: "secret" }, "http://localhost:3000", starter).url).searchParams.get("state")!;

  it("is finished as whoever began it, with the role they have when the network sends the browser back", async () => {
    const owner = members.listMembers().find((m) => m.role === "owner")!;
    const { member } = await add(owner, "Connects Accounts", "admin");
    const state = begin({ member_id: member.id, role: "admin" });
    expect(oauthStarter(state)).toMatchObject({ role: "admin", member: { id: member.id } });
    // Peeking does not use the sign-in up.
    expect(oauthStarter(state)).toMatchObject({ role: "admin" });
    members.setRole(asker(owner), member.id, "editor");
    expect(oauthStarter(state)).toMatchObject({ role: "editor" });
    members.setDisabled(asker(owner), member.id, true);
    expect(oauthStarter(state)).toBeNull();
    members.setDisabled(asker(owner), member.id, false);
    members.setRole(asker(owner), member.id, "owner");
    // Begun as an admin: being promoted meanwhile does not raise it.
    expect(oauthStarter(state)).toMatchObject({ role: "admin" });
    expect((await finishOAuth("x", state, "code", net)).account?.handle).toBe("@tester");
    expect(oauthStarter(state)).toBeUndefined();
    members.setRole(asker(owner), member.id, "admin");
  });

  it("speaks for no one when it was begun before the team, or is unknown", () => {
    expect(oauthStarter(begin(null))).toBeNull();
    expect(oauthStarter("not-a-state")).toBeUndefined();
    expect(oauthStarter("")).toBeUndefined();
  });
});

describe("recovery from the server", () => {
  it("resets a password with a one-time link, signing the member out at once", async () => {
    const owner = members.listMembers().find((m) => m.role === "owner")!;
    const { member, password } = await add(owner, "Forgot It", "editor");
    const cookie = await cookieFor(member.id);
    const key = createMemberKey({ id: member.id, role: "editor" }, "survives a reset", "viewer");
    const { token } = members.resetMember("forgot  IT");
    expect(await roleNow(cookie)).toBeNull();
    expect(await members.signIn("Forgot It", password)).toBeNull();
    expect(members.peekInvite(token)).toEqual({ name: "Forgot It", role: "editor", reset: true });
    expect(members.listInvites().find((i) => i.name === "Forgot It")).toMatchObject({ reset: true, created_by: null });
    const fresh = aPassword();
    const back = await members.acceptInvite(token, fresh);
    expect(back.id).toBe(member.id);
    expect(back.role).toBe("editor");
    expect(await members.signIn("Forgot It", fresh)).toMatchObject({ id: member.id });
    await expect(members.acceptInvite(token, aPassword())).rejects.toThrow(members.INVITE_GONE);
    // The member is the same member: their key still works, with their limits.
    expect(tokenActor(key.token)).toMatchObject({ role: "viewer", member: { id: member.id } });
    expect(() => members.resetMember("Nobody Called This")).toThrow("No member called Nobody Called This.");
  });

  it("keeps only the newest reset link, and a reset does not enable a disabled member", async () => {
    const owner = members.listMembers().find((m) => m.role === "owner")!;
    const { member } = await add(owner, "Reset Twice", "viewer");
    const first = members.resetMember("Reset Twice").token;
    const second = members.resetMember("Reset Twice").token;
    expect(members.peekInvite(first)).toBeNull();
    expect(members.peekInvite(second)).not.toBeNull();
    members.disableMemberByName("Reset Twice");
    await expect(members.acceptInvite(second, aPassword())).rejects.toThrow(members.INVITE_GONE);
    expect(members.enableMemberByName("Reset Twice").disabled_at).toBeNull();
    expect(members.getMember(member.id)!.role).toBe("viewer");
  });

  it("gets the last owner back in without ever disabling them", async () => {
    const owner = members.listMembers().find((m) => m.role === "owner")!;
    expect(() => members.disableMemberByName(owner.name)).toThrow(/is the only owner. Reset their password instead/);
    const { token } = members.resetMember(owner.name);
    const fresh = aPassword();
    expect((await members.acceptInvite(token, fresh)).id).toBe(owner.id);
    expect(await members.signIn(owner.name, fresh)).toMatchObject({ role: "owner" });
  });

  it("dissolves the team: single-user again, member keys gone, and nothing else touched", async () => {
    const owner = members.listMembers().find((m) => m.role === "owner")!;
    const cookie = await cookieFor(owner.id);
    const memberKey = createMemberKey(asker(owner), "made in the team", "viewer");
    const waiting = members.createInvite(asker(owner), { name: "Never Joined", role: "admin" });
    const postsBefore = all("SELECT id FROM posts").length;
    const accountsBefore = all("SELECT id FROM accounts").length;

    const gone = members.dissolveTeam();
    expect(gone.members).toBeGreaterThan(5);
    expect(gone.keys).toBeGreaterThan(0);
    expect(members.teamMode()).toBe(false);
    expect(members.listMembers()).toEqual([]);
    expect(members.listInvites()).toEqual([]);
    // A viewer's key must not come back as an owner's: it is gone.
    expect(tokenActor(memberKey.token)).toBeNull();
    // The key from before the team is what it was before the team.
    expect(tokenActor(oldKey)).toEqual({ role: "owner", member: null, team: false, via: "key" });
    await expect(members.acceptInvite(waiting.token, aPassword())).rejects.toThrow(members.INVITE_GONE);
    expect(all("SELECT id FROM posts")).toHaveLength(postsBefore);
    expect(all("SELECT id FROM accounts")).toHaveLength(accountsBefore);
    // Back to how it was: open on this machine, and behind the shared password when one is set.
    expect(await sessionActor(new Request("http://localhost/"))).toMatchObject({ role: "owner", team: false, via: "open" });
    process.env.BROADSIDE_PASSWORD = "the shared one";
    expect(await sessionActor(withCookie(cookie))).toBeNull();
    expect(await sessionActor(withCookie(await sessionValue()))).toMatchObject({ role: "owner", via: "password" });
    delete process.env.BROADSIDE_PASSWORD;
    // And a new team can be started from scratch.
    expect((await members.startTeam({ name: "Fresh Start", password: aPassword() })).role).toBe("owner");
    expect(members.dissolveTeam().members).toBe(1);
  });
});
