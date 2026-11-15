import { getAccount, InputError } from "./accounts";
import { newId } from "./crypto";
import { all, db, get, now, run } from "./db";

/**
 * A group is a named set of connected accounts, such as "Launch day". Picking
 * it names exactly those accounts as a post's targets. Membership follows the
 * accounts table: disconnecting an account removes it from every group.
 */

export type GroupMember = { id: string; platform: string; handle: string };
export type Group = { id: string; name: string; account_ids: string[]; accounts: GroupMember[]; created_at: string };

type GroupRow = { id: string; name: string; name_key: string; created_at: string };

export const MAX_GROUP_NAME = 60;

const nameKey = (name: string): string => name.normalize("NFKC").toLowerCase();

function cleanName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new InputError("A group needs a name.");
  const name = value.trim().replace(/\s+/g, " ");
  if ([...name].length > MAX_GROUP_NAME) throw new InputError(`A group name can be ${MAX_GROUP_NAME} characters; this is ${[...name].length}.`);
  return name;
}

/** The accounts a caller listed, each checked to exist and kept once. */
function cleanMembers(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) throw new InputError("account_ids must be a list of account ids.");
  const ids = [...new Set(value as string[])];
  if (!ids.length) throw new InputError("A group needs at least one account.");
  for (const id of ids) if (!getAccount(id)) throw new InputError(`No connected account has the id ${id}.`);
  return ids;
}

function view(row: GroupRow): Group {
  // Joined to accounts, so a member whose account is gone is never listed even if its row lingered.
  const accounts = all<GroupMember>(
    "SELECT a.id, a.platform, a.handle FROM group_members m JOIN accounts a ON a.id = m.account_id WHERE m.group_id = ? ORDER BY a.created_at, a.rowid",
    row.id,
  );
  return { id: row.id, name: row.name, account_ids: accounts.map((a) => a.id), accounts, created_at: row.created_at };
}

export function listGroups(): Group[] {
  return all<GroupRow>("SELECT * FROM account_groups ORDER BY name_key").map(view);
}

export function getGroup(id: string): Group | undefined {
  const row = get<GroupRow>("SELECT * FROM account_groups WHERE id = ?", id);
  return row && view(row);
}

function nameFree(name: string, exceptId: string | null): void {
  const taken = get<GroupRow>("SELECT * FROM account_groups WHERE name_key = ? AND id <> ?", nameKey(name), exceptId ?? "");
  if (taken) throw new InputError(`A group called "${taken.name}" already exists.`);
}

function setMembers(groupId: string, accountIds: string[]): void {
  run("DELETE FROM group_members WHERE group_id = ?", groupId);
  for (const accountId of accountIds) run("INSERT INTO group_members (group_id, account_id) VALUES (?, ?)", groupId, accountId);
}

export function createGroup(input: { name?: unknown; account_ids?: unknown }): Group {
  const name = cleanName(input.name);
  const members = cleanMembers(input.account_ids);
  nameFree(name, null);
  const id = newId("grp");
  const database = db();
  database.exec("BEGIN");
  try {
    run("INSERT INTO account_groups (id, name, name_key, created_at) VALUES (?, ?, ?, ?)", id, name, nameKey(name), now());
    setMembers(id, members);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return getGroup(id)!;
}

/** Renames a group, replaces its members, or both. What is left out stays as it is. */
export function updateGroup(id: string, patch: { name?: unknown; account_ids?: unknown }): Group {
  if (!getGroup(id)) throw new InputError(`No group with id ${id}.`);
  const name = patch.name === undefined ? null : cleanName(patch.name);
  const members = patch.account_ids === undefined ? null : cleanMembers(patch.account_ids);
  if (name) nameFree(name, id);
  const database = db();
  database.exec("BEGIN");
  try {
    if (name) run("UPDATE account_groups SET name = ?, name_key = ? WHERE id = ?", name, nameKey(name), id);
    if (members) setMembers(id, members);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return getGroup(id)!;
}

/** Deletes the group only. Its accounts stay connected. */
export function deleteGroup(id: string): boolean {
  return run("DELETE FROM account_groups WHERE id = ?", id) > 0;
}

/** The accounts a group names right now, as the targets of a post. */
export function groupTargets(id: string): { account_id: string }[] {
  const group = getGroup(id);
  if (!group) throw new InputError(`No group with id ${id}. Call list_groups for the current ids.`);
  if (!group.account_ids.length) throw new InputError(`The group "${group.name}" has no accounts left. Add an account to it, or name the targets directly.`);
  return group.account_ids.map((account_id) => ({ account_id }));
}
