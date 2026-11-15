import { newId, open, seal } from "./crypto";
import { all, get, now, run } from "./db";
import { guardedFetch } from "./net";
import { connector } from "./platforms";
import { PublishError, type Connector, type Credentials } from "./platforms/types";

export type Account = {
  id: string;
  platform: string;
  label: string;
  handle: string;
  avatar_url: string | null;
  status: "active" | "needs_attention";
  last_error: string | null;
  /** The saved signature the composer offers for this account, if it has one. */
  signature_id: string | null;
  created_at: string;
};

type AccountRow = Account & { credentials: string };

/** Everything about an account except its credentials, which never leave the server. */
function publicView(row: AccountRow): Account {
  const { id, platform, label, handle, avatar_url, status, last_error, signature_id, created_at } = row;
  return { id, platform, label, handle, avatar_url, status, last_error, signature_id: signature_id ?? null, created_at };
}

export class InputError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "InputError";
  }
}

export function listAccounts(): Account[] {
  return all<AccountRow>("SELECT * FROM accounts ORDER BY created_at").map(publicView);
}

export function getAccount(id: string): Account | undefined {
  const row = get<AccountRow>("SELECT * FROM accounts WHERE id = ?", id);
  return row && publicView(row);
}

export function credentialsOf(id: string): Credentials {
  const row = get<AccountRow>("SELECT * FROM accounts WHERE id = ?", id);
  if (!row) throw new InputError(`No account with id ${id}.`);
  return open<Credentials>(row.credentials);
}

export function saveCredentials(id: string, credentials: Credentials): void {
  run("UPDATE accounts SET credentials = ? WHERE id = ?", seal(credentials), id);
}

export function markAccount(id: string, error: string | null): void {
  run("UPDATE accounts SET status = ?, last_error = ? WHERE id = ?", error ? "needs_attention" : "active", error, id);
}

/** Checks the credentials against the network before saving anything. */
export async function connectAccount(platform: string, input: Credentials, fetcher: typeof fetch = fetch): Promise<Account> {
  const c = connector(platform);
  if (!c) throw new InputError(`Broadside has no connector called "${platform}".`);
  const credentials: Credentials = {};
  for (const field of c.fields) {
    const value = (input[field.key] ?? "").trim();
    if (!value && !field.optional) throw new InputError(`${field.label} is required to connect ${c.name}.`);
    if (value) credentials[field.key] = value;
  }
  return saveVerified(c, credentials, fetcher);
}

/** Asks the network who these credentials belong to, and stores the account only if it answers. A sign-in ends here too. */
export async function saveVerified(c: Connector, credentials: Credentials, fetcher: typeof fetch = fetch): Promise<Account> {
  let profile;
  try {
    profile = await c.verify(credentials, { fetch: guardedFetch(fetcher) });
  } catch (error) {
    if (error instanceof PublishError) throw new InputError(error.message);
    throw new InputError(`${c.name} did not accept those details: ${(error as Error).message}`);
  }
  const id = newId("acc");
  run(
    "INSERT INTO accounts (id, platform, label, handle, avatar_url, credentials, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    id,
    c.id,
    c.name,
    profile.handle,
    profile.avatarUrl ?? null,
    seal({ ...credentials, ...profile.credentials }),
    now(),
  );
  return getAccount(id)!;
}

export function removeAccount(id: string): boolean {
  return run("DELETE FROM accounts WHERE id = ?", id) > 0;
}
