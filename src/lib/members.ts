import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { InputError } from "./accounts";
import { newId, sha256 } from "./crypto";
import { all, db, get, now, run } from "./db";
import { atLeast, grants, isRole, manages, type Role } from "./roles";

/**
 * Team members. While nobody has been added, Broadside is single-user and
 * none of this is in play. The first member is made by whoever runs the
 * install and becomes its owner; from then on every browser session belongs
 * to a member and carries that member's role.
 *
 * Nobody but a member ever sets that member's password. People are added by
 * a one-time link they open themselves, and an admin can disable a member or
 * change a role but never see or choose a password.
 */
export type Member = { id: string; name: string; role: Role; created_at: string; disabled_at: string | null; last_seen_at: string | null };
type MemberRow = Member & { name_key: string; password_hash: string; session_nonce: string };

export type Invite = { id: string; name: string; role: Role; created_by: string | null; created_at: string; expires_at: string; reset: boolean };

/** Who is asking for a change to the team: a member's id and the role read from the database for this request. */
export type Asker = { id: string; role: Role };

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 200;
export const NAME_MAX = 40;
export const INVITE_DAYS = 7;

const MEMBER_COLUMNS = "id, name, role, created_at, disabled_at, last_seen_at";

/* Names -------------------------------------------------------------------- */

/** A name as it is shown: trimmed, with runs of spaces made one. */
export function cleanName(value: unknown): string {
  if (typeof value !== "string") throw new InputError("Give the member a name.");
  const name = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!name) throw new InputError("Give the member a name.");
  if ([...name].length > NAME_MAX) throw new InputError(`A name can be ${NAME_MAX} characters at most.`);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new InputError("A name cannot contain control characters.");
  return name;
}

/** The form a name is compared in, so "Ada", "ada" and " ADA " are one member. */
export const nameKey = (name: string): string => name.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

/* Passwords ---------------------------------------------------------------- */

/**
 * scrypt, with the cost stored beside each hash so it can be raised later
 * without breaking the hashes already made. N = 2^15, r = 8, p = 3 is one of
 * the settings OWASP lists for scrypt, and holds 32 MB while it works. The
 * tests lower N; nothing else changes it.
 */
export const passwordCost = { N: 32768, r: 8, p: 3 };
const KEY_BYTES = 32;

function derive(password: string, salt: Buffer, cost: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, KEY_BYTES, { ...cost, maxmem: 256 * 1024 * 1024 }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export function checkPassword(value: unknown): string {
  if (typeof value !== "string" || !value) throw new InputError("Choose a password.");
  const length = [...value].length;
  if (length < PASSWORD_MIN) throw new InputError(`A password needs at least ${PASSWORD_MIN} characters. This one has ${length}.`);
  if (length > PASSWORD_MAX) throw new InputError(`A password can be ${PASSWORD_MAX} characters at most.`);
  return value;
}

/** `scrypt$N$r$p$salt$hash`: everything needed to check a password later, and nothing that helps guess it. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const { N, r, p } = passwordCost;
  const key = await derive(password, salt, { N, r, p });
  return ["scrypt", N, r, p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

/** A hash no password matches: what a member has between a reset and opening the link. */
const unusable = (): string => `reset$${randomBytes(18).toString("base64url")}`;

const dummySalt = randomBytes(16);

/**
 * Checks a password against a stored hash. An unknown member, a disabled one
 * and one waiting on a reset link all cost one derivation at today's settings,
 * so the time taken says nothing about which names exist.
 */
export async function passwordMatches(password: string, stored: string | null): Promise<boolean> {
  const [scheme, N, r, p, salt, hash] = (stored ?? "").split("$");
  if (scheme !== "scrypt" || !salt || !hash) {
    await derive(password.slice(0, PASSWORD_MAX * 4), dummySalt, passwordCost);
    return false;
  }
  const expected = Buffer.from(hash, "base64url");
  const actual = await derive(password.slice(0, PASSWORD_MAX * 4), Buffer.from(salt, "base64url"), { N: Number(N), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/* Reading ------------------------------------------------------------------ */

/** True once the install has members. Read from the database every time: the answer decides who may do anything at all. */
export function teamMode(): boolean {
  return Boolean(get("SELECT 1 AS team FROM members LIMIT 1"));
}

export function listMembers(): Member[] {
  return all<Member>(`SELECT ${MEMBER_COLUMNS} FROM members ORDER BY created_at, name_key`);
}

export function getMember(id: string): Member | undefined {
  return get<Member>(`SELECT ${MEMBER_COLUMNS} FROM members WHERE id = ?`, id);
}

/** What a session is signed with, and who it belongs to. Null for a member who is disabled or gone. */
export function sessionMember(id: string): { member: Member; secret: string } | null {
  const row = get<MemberRow>("SELECT * FROM members WHERE id = ?", id);
  if (!row || row.disabled_at) return null;
  return { member: getMember(id)!, secret: `${row.password_hash}\u0000${row.session_nonce}` };
}

/** Notes that a member was here, at most once a minute so reading a page does not write on every request. */
export function touchMember(id: string): void {
  const stamp = now();
  run("UPDATE members SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)", stamp, id, new Date(Date.now() - 60_000).toISOString());
}

/** Names for a set of member ids, for showing who wrote a post. An id with no member (removed since) is left out. */
export function memberNames(ids: (string | null)[]): Record<string, string> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  const names: Record<string, string> = {};
  for (const id of wanted) {
    const row = get<{ name: string }>("SELECT name FROM members WHERE id = ?", id);
    if (row) names[id] = row.name;
  }
  return names;
}

/* Starting a team ---------------------------------------------------------- */

/**
 * Makes the first member, who is the owner. One statement inserts only while
 * the table is empty, so two people setting up a team at the same moment get
 * one team and one of them is told it already exists.
 */
export async function startTeam(input: { name?: unknown; password?: unknown }): Promise<Member> {
  const name = cleanName(input.name);
  const hash = await hashPassword(checkPassword(input.password));
  const id = newId("mem");
  const made = run(
    "INSERT INTO members (id, name, name_key, role, password_hash, session_nonce, created_at) SELECT ?, ?, ?, 'owner', ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM members)",
    id,
    name,
    nameKey(name),
    hash,
    randomBytes(18).toString("base64url"),
    now(),
  );
  if (!made) throw new InputError("This Broadside already has a team. Sign in as a member.");
  return getMember(id)!;
}

/* Signing in --------------------------------------------------------------- */

/** The member for a name and password, or null. A wrong name, a wrong password and a disabled member all answer null after the same work. */
export async function signIn(name: unknown, password: unknown): Promise<Member | null> {
  const row = typeof name === "string" ? get<MemberRow>("SELECT * FROM members WHERE name_key = ?", nameKey(name.slice(0, 400))) : undefined;
  const usable = row && !row.disabled_at ? row.password_hash : null;
  const right = await passwordMatches(typeof password === "string" ? password : "", usable);
  if (!right || !row) return null;
  touchMember(row.id);
  return getMember(row.id)!;
}

/** A member changes their own password, proving the current one. Every session of theirs ends, here and elsewhere. */
export async function changePassword(memberId: string, current: unknown, next: unknown): Promise<Member> {
  const row = get<MemberRow>("SELECT * FROM members WHERE id = ?", memberId);
  if (!row || row.disabled_at) throw new InputError("That member cannot sign in any more.");
  const fresh = checkPassword(next);
  if (!(await passwordMatches(typeof current === "string" ? current : "", row.password_hash))) throw new InputError("That is not your current password.");
  if (current === fresh) throw new InputError("The new password is the same as the current one.");
  const hash = await hashPassword(fresh);
  // Only if the hash is still the one just checked: two changes at once cannot both win.
  if (!run("UPDATE members SET password_hash = ? WHERE id = ? AND password_hash = ?", hash, memberId, row.password_hash)) throw new InputError("Your password was changed a moment ago. Sign in again.");
  return getMember(memberId)!;
}

/* Changing members --------------------------------------------------------- */

/** Runs a change as one write, so "is there another owner?" and the change itself cannot be split by anything else. */
function atomically<T>(work: () => T): T {
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

const otherOwners = (id: string): number => Number(get<{ n: number }>("SELECT COUNT(*) AS n FROM members WHERE role = 'owner' AND disabled_at IS NULL AND id <> ?", id)?.n ?? 0);

/** The asker's role as the database has it now, never as a cookie or a caller says it is. */
function current(asker: Asker): Role {
  const row = get<{ role: string; disabled_at: string | null }>("SELECT role, disabled_at FROM members WHERE id = ?", asker.id);
  if (!row || row.disabled_at || !isRole(row.role)) throw new InputError("You are no longer a member of this Broadside.");
  return row.role;
}

/**
 * Withdraws the invites a member made that they could not make now: all of
 * them once they are disabled or removed, and those above their new role once
 * they are demoted. An admin on the way out cannot leave a door open behind them.
 */
function pruneInvites(memberId: string): void {
  const row = get<{ role: string; disabled_at: string | null }>("SELECT role, disabled_at FROM members WHERE id = ?", memberId);
  const role = row && !row.disabled_at && isRole(row.role) ? row.role : null;
  for (const waiting of all<{ id: string; role: string }>("SELECT id, role FROM invites WHERE created_by = ? AND used_at IS NULL", memberId)) {
    if (!role || !isRole(waiting.role) || !grants(role, waiting.role)) run("DELETE FROM invites WHERE id = ?", waiting.id);
  }
}

function target(id: string): MemberRow {
  const row = get<MemberRow>("SELECT * FROM members WHERE id = ?", id);
  if (!row) throw new InputError(`No member with id ${id}.`);
  return row;
}

/**
 * Changes a member's role. Nobody changes their own. An admin changes only
 * editors and viewers and can give at most admin; an owner can do both to
 * anyone. The last owner who can sign in stays an owner.
 */
export function setRole(asker: Asker, memberId: string, role: unknown): Member {
  if (!isRole(role)) throw new InputError("A role is one of viewer, editor, admin or owner.");
  return atomically(() => {
    const mine = current(asker);
    const member = target(memberId);
    if (member.id === asker.id) throw new InputError("You cannot change your own role. Ask another owner.");
    if (!manages(mine, member.role)) throw new InputError(`Changing ${member.name}'s role needs ${member.role === "owner" || member.role === "admin" ? "an owner" : "an admin"}.`);
    if (!grants(mine, role)) throw new InputError(`You can give a role up to your own, which is ${mine}.`);
    if (member.role === "owner" && role !== "owner" && !member.disabled_at && otherOwners(member.id) === 0) throw new InputError("This is the only owner. Make someone else an owner first.");
    run("UPDATE members SET role = ? WHERE id = ?", role, member.id);
    pruneInvites(member.id);
    return getMember(member.id)!;
  });
}

/** Disables a member: they are signed out everywhere on their next request and their API keys stop working. Enabling lets them sign in again. */
export function setDisabled(asker: Asker, memberId: string, disabled: boolean): Member {
  return atomically(() => {
    const mine = current(asker);
    const member = target(memberId);
    if (member.id === asker.id) throw new InputError("You cannot disable yourself. Ask another owner.");
    if (!manages(mine, member.role)) throw new InputError(`${disabled ? "Disabling" : "Enabling"} ${member.name} needs ${member.role === "owner" || member.role === "admin" ? "an owner" : "an admin"}.`);
    if (disabled && member.role === "owner" && otherOwners(member.id) === 0) throw new InputError("This is the only owner. Make someone else an owner first.");
    // A new nonce means the sessions signed before this moment stay dead even if the member is enabled again.
    if (disabled) run("UPDATE members SET disabled_at = COALESCE(disabled_at, ?), session_nonce = ? WHERE id = ?", now(), randomBytes(18).toString("base64url"), member.id);
    else run("UPDATE members SET disabled_at = NULL WHERE id = ?", member.id);
    pruneInvites(member.id);
    return getMember(member.id)!;
  });
}

/** Removes a member for good, with their API keys. Posts they wrote stay, without a name. */
export function removeMember(asker: Asker, memberId: string): void {
  atomically(() => {
    const mine = current(asker);
    const member = target(memberId);
    if (member.id === asker.id) throw new InputError("You cannot remove yourself. Ask another owner.");
    if (!manages(mine, member.role)) throw new InputError(`Removing ${member.name} needs ${member.role === "owner" || member.role === "admin" ? "an owner" : "an admin"}.`);
    if (member.role === "owner" && !member.disabled_at && otherOwners(member.id) === 0) throw new InputError("This is the only owner. Make someone else an owner first.");
    run("DELETE FROM api_keys WHERE member_id = ?", member.id);
    run("DELETE FROM invites WHERE member_id = ?", member.id);
    run("DELETE FROM members WHERE id = ?", member.id);
    pruneInvites(member.id);
  });
}

/* Invites ------------------------------------------------------------------ */

const INVITE_COLUMNS = "id, name, role, created_by, created_at, expires_at, member_id IS NOT NULL AS reset";
type InviteRow = Omit<Invite, "reset"> & { reset: number };
const invite = (row: InviteRow): Invite => ({ ...row, reset: Boolean(row.reset) });

/** 32 random bytes. Only its hash is stored, so the database cannot be turned back into a working link. */
const newInviteToken = (): string => randomBytes(32).toString("base64url");

function addInvite(input: { name: string; role: Role; member_id: string | null; created_by: string | null }): { invite: Invite; token: string } {
  const token = newInviteToken();
  const id = newId("inv");
  run(
    "INSERT INTO invites (id, token_hash, role, name, name_key, member_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    sha256(token),
    input.role,
    input.name,
    nameKey(input.name),
    input.member_id,
    input.created_by,
    now(),
    new Date(Date.now() + INVITE_DAYS * 24 * 3600_000).toISOString(),
  );
  return { invite: invite(get<InviteRow>(`SELECT ${INVITE_COLUMNS} FROM invites WHERE id = ?`, id)!), token };
}

/**
 * Invites someone by name, with a role no higher than the inviter's own. The
 * token comes back once, to be put in a link; nothing that could rebuild it is kept.
 */
export function createInvite(asker: Asker, input: { name?: unknown; role?: unknown }): { invite: Invite; token: string } {
  const name = cleanName(input.name);
  if (!isRole(input.role)) throw new InputError("A role is one of viewer, editor, admin or owner.");
  const role = input.role;
  return atomically(() => {
    const mine = current(asker);
    if (!atLeast(mine, "admin")) throw new InputError("Inviting someone needs an admin.");
    if (!grants(mine, role)) throw new InputError(`You can invite someone with a role up to your own, which is ${mine}.`);
    if (get("SELECT 1 AS taken FROM members WHERE name_key = ?", nameKey(name))) throw new InputError(`There is already a member called ${name}. Names are compared without capitals or extra spaces.`);
    run("DELETE FROM invites WHERE used_at IS NOT NULL OR expires_at < ?", now());
    if (get("SELECT 1 AS waiting FROM invites WHERE name_key = ? AND member_id IS NULL", nameKey(name))) throw new InputError(`There is already an invite waiting for ${name}. Revoke it first to make a new one.`);
    return addInvite({ name, role, member_id: null, created_by: asker.id });
  });
}

/** The invites nobody has used yet and that have not run out. Password resets made on the server are listed with them. */
export function listInvites(): Invite[] {
  return all<InviteRow>(`SELECT ${INVITE_COLUMNS} FROM invites WHERE used_at IS NULL AND expires_at >= ? ORDER BY created_at DESC`, now()).map(invite);
}

/** Withdraws an invite, under the same rule as making it: only for a role the asker could give. */
export function revokeInvite(asker: Asker, inviteId: string): void {
  atomically(() => {
    const mine = current(asker);
    const row = get<{ role: string }>("SELECT role FROM invites WHERE id = ?", inviteId);
    if (!row || !isRole(row.role)) throw new InputError("That invite is gone already.");
    if (!grants(mine, row.role)) throw new InputError(`You can revoke invites for roles up to your own, which is ${mine}.`);
    run("DELETE FROM invites WHERE id = ?", inviteId);
  });
}

type InviteLookup = { id: string; name: string; role: Role; member_id: string | null };

function liveInvite(token: unknown): InviteLookup | null {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return null;
  const row = get<InviteLookup & { used_at: string | null; expires_at: string }>("SELECT id, name, role, member_id, used_at, expires_at FROM invites WHERE token_hash = ?", sha256(token));
  if (!row || row.used_at || row.expires_at < now() || !isRole(row.role)) return null;
  return { id: row.id, name: row.name, role: row.role, member_id: row.member_id };
}

/** What the join page shows before a password is chosen: the name and role waiting, or nothing if the link is used, expired or wrong. */
export function peekInvite(token: unknown): { name: string; role: Role; reset: boolean } | null {
  const found = liveInvite(token);
  return found && { name: found.name, role: found.role, reset: Boolean(found.member_id) };
}

export const INVITE_GONE = "This link has been used, has run out, or was never valid. Ask whoever invited you for a new one.";

/**
 * Uses an invite: the person sets their own password and becomes a member
 * (or, for a reset link, gets a new password). The invite is claimed with a
 * compare-and-set inside the same write as the member, so a link works once
 * however many times it is opened at the same moment.
 */
export async function acceptInvite(token: unknown, password: unknown): Promise<Member> {
  const found = liveInvite(token);
  if (!found) throw new InputError(INVITE_GONE);
  const hash = await hashPassword(checkPassword(password));
  return atomically(() => {
    if (!run("UPDATE invites SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at >= ?", now(), found.id, now())) throw new InputError(INVITE_GONE);
    if (found.member_id) {
      const member = get<MemberRow>("SELECT * FROM members WHERE id = ?", found.member_id);
      if (!member || member.disabled_at) throw new InputError(INVITE_GONE);
      run("UPDATE members SET password_hash = ?, session_nonce = ? WHERE id = ?", hash, randomBytes(18).toString("base64url"), member.id);
      return getMember(member.id)!;
    }
    // An invite only ever joins a team that exists. If the team was dissolved on the server, the link dies with it.
    if (!teamMode()) throw new InputError(INVITE_GONE);
    if (get("SELECT 1 AS taken FROM members WHERE name_key = ?", nameKey(found.name))) throw new InputError(`There is already a member called ${found.name}. Ask for an invite under another name.`);
    const id = newId("mem");
    run("INSERT INTO members (id, name, name_key, role, password_hash, session_nonce, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", id, found.name, nameKey(found.name), found.role, hash, randomBytes(18).toString("base64url"), now());
    return getMember(id)!;
  });
}

/* Recovery, for the command line ------------------------------------------- */

/**
 * These are for `npm run members`, run by someone who can already read
 * the data folder. They take no asker: that person could edit the database
 * by hand. Nothing in the web app calls them.
 */
export function findMemberByName(name: string): Member | undefined {
  return get<Member>(`SELECT ${MEMBER_COLUMNS} FROM members WHERE name_key = ?`, nameKey(name));
}

/** Throws away a member's password and returns a one-time link token for choosing a new one. They are signed out everywhere at once. A disabled member stays disabled. */
export function resetMember(name: string): { member: Member; token: string } {
  return atomically(() => {
    const member = findMemberByName(name);
    if (!member) throw new InputError(`No member called ${name}.`);
    run("UPDATE members SET password_hash = ?, session_nonce = ? WHERE id = ?", unusable(), randomBytes(18).toString("base64url"), member.id);
    run("DELETE FROM invites WHERE member_id = ?", member.id);
    const { token } = addInvite({ name: member.name, role: member.role, member_id: member.id, created_by: null });
    return { member: getMember(member.id)!, token };
  });
}

/** Disables a member from the server. The last owner is still refused: use reset to get back in, or dissolve the team. */
export function disableMemberByName(name: string): Member {
  return atomically(() => {
    const member = findMemberByName(name);
    if (!member) throw new InputError(`No member called ${name}.`);
    if (member.role === "owner" && otherOwners(member.id) === 0) throw new InputError(`${member.name} is the only owner. Reset their password instead, or dissolve the team.`);
    run("UPDATE members SET disabled_at = COALESCE(disabled_at, ?), session_nonce = ? WHERE id = ?", now(), randomBytes(18).toString("base64url"), member.id);
    pruneInvites(member.id);
    return getMember(member.id)!;
  });
}

export function enableMemberByName(name: string): Member {
  const member = findMemberByName(name);
  if (!member) throw new InputError(`No member called ${name}.`);
  run("UPDATE members SET disabled_at = NULL WHERE id = ?", member.id);
  return getMember(member.id)!;
}

/**
 * Removes every member and invite, and every API key that belonged to a
 * member, and returns the install to single-user mode. A key made by a member
 * had that member's limits; with the member gone it must not become a key
 * with none. Posts, accounts and keys from before the team are untouched.
 */
export function dissolveTeam(): { members: number; invites: number; keys: number } {
  return atomically(() => {
    const keys = run("DELETE FROM api_keys WHERE member_id IS NOT NULL OR role IS NOT NULL");
    const invites = run("DELETE FROM invites");
    const members = run("DELETE FROM members");
    return { members, invites, keys };
  });
}
