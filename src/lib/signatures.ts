import { getAccount, InputError, type Account } from "./accounts";
import { newId } from "./crypto";
import { all, db, get, now, run } from "./db";

/**
 * Signatures are saved pieces of text: a sign-off, a set of hashtags. Adding
 * one to a post copies its text into the post, where it is edited and counted
 * like anything else. An account may name one as its default; the composer
 * offers that one and never adds it by itself.
 */

export type Signature = {
  id: string;
  name: string;
  content: string;
  /** The accounts that offer this signature by default. */
  default_for: string[];
  created_at: string;
  updated_at: string;
};

type SignatureRow = Omit<Signature, "default_for">;

export const MAX_SIGNATURE_NAME = 60;
export const MAX_SIGNATURE_CHARS = 2000;

function cleanName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new InputError("A signature needs a name.");
  const name = value.trim().replace(/\s+/g, " ");
  if ([...name].length > MAX_SIGNATURE_NAME) throw new InputError(`A signature name can be ${MAX_SIGNATURE_NAME} characters; this is ${[...name].length}.`);
  return name;
}

function cleanContent(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new InputError("A signature needs some text.");
  const content = value.trim();
  if ([...content].length > MAX_SIGNATURE_CHARS) throw new InputError(`A signature can be ${MAX_SIGNATURE_CHARS} characters; this is ${[...content].length}.`);
  return content;
}

function view(row: SignatureRow): Signature {
  const accounts = all<{ id: string }>("SELECT id FROM accounts WHERE signature_id = ? ORDER BY created_at, rowid", row.id);
  return { ...row, default_for: accounts.map((a) => a.id) };
}

export function listSignatures(): Signature[] {
  return all<SignatureRow>("SELECT * FROM signatures ORDER BY name COLLATE NOCASE, created_at").map(view);
}

export function getSignature(id: string): Signature | undefined {
  const row = get<SignatureRow>("SELECT * FROM signatures WHERE id = ?", id);
  return row && view(row);
}

/** The accounts a caller wants this signature offered for, each checked to exist. */
function cleanAccounts(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) throw new InputError("default_for must be a list of account ids.");
  const ids = [...new Set(value as string[])];
  for (const id of ids) if (!getAccount(id)) throw new InputError(`No connected account has the id ${id}.`);
  return ids;
}

/** Makes this the default of exactly these accounts. An account has one default, so naming it here replaces any other. */
function setDefaults(signatureId: string, accountIds: string[]): void {
  run("UPDATE accounts SET signature_id = NULL WHERE signature_id = ?", signatureId);
  for (const accountId of accountIds) run("UPDATE accounts SET signature_id = ? WHERE id = ?", signatureId, accountId);
}

export function createSignature(input: { name?: unknown; content?: unknown; default_for?: unknown }): Signature {
  const name = cleanName(input.name);
  const content = cleanContent(input.content);
  const accounts = input.default_for === undefined ? [] : cleanAccounts(input.default_for);
  const id = newId("sig");
  const stamp = now();
  const database = db();
  database.exec("BEGIN");
  try {
    run("INSERT INTO signatures (id, name, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", id, name, content, stamp, stamp);
    setDefaults(id, accounts);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return getSignature(id)!;
}

/** Changes the name, the text, or which accounts offer it. What is left out stays as it is. Posts already written keep the text they were given. */
export function updateSignature(id: string, patch: { name?: unknown; content?: unknown; default_for?: unknown }): Signature {
  const current = getSignature(id);
  if (!current) throw new InputError(`No signature with id ${id}.`);
  const name = patch.name === undefined ? current.name : cleanName(patch.name);
  const content = patch.content === undefined ? current.content : cleanContent(patch.content);
  const accounts = patch.default_for === undefined ? null : cleanAccounts(patch.default_for);
  const database = db();
  database.exec("BEGIN");
  try {
    run("UPDATE signatures SET name = ?, content = ?, updated_at = ? WHERE id = ?", name, content, now(), id);
    if (accounts) setDefaults(id, accounts);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return getSignature(id)!;
}

/** Deletes the saved text. Accounts that offered it offer nothing, and posts that already contain it are not touched. */
export function deleteSignature(id: string): boolean {
  run("UPDATE accounts SET signature_id = NULL WHERE signature_id = ?", id);
  return run("DELETE FROM signatures WHERE id = ?", id) > 0;
}

/** Sets or clears the signature one account offers by default. */
export function setAccountSignature(accountId: string, signatureId: unknown): Account {
  if (!getAccount(accountId)) throw new InputError(`No account with id ${accountId}.`);
  if (signatureId !== null && typeof signatureId !== "string") throw new InputError("signature_id must be a signature's id, or null to offer none.");
  if (signatureId !== null && !getSignature(signatureId)) throw new InputError(`No signature with id ${signatureId}.`);
  run("UPDATE accounts SET signature_id = ? WHERE id = ?", signatureId, accountId);
  return getAccount(accountId)!;
}
