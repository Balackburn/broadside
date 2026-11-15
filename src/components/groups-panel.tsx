"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, Dialog, Icon, Stamp } from "./ui";

type Account = { id: string; platform: string; handle: string };
export type GroupInfo = { id: string; name: string; account_ids: string[]; accounts: Account[] };

/** Named sets of accounts. Picking one in the composer selects exactly its accounts. */
export function GroupsPanel({ accounts, groups, show }: { accounts: Account[]; groups: GroupInfo[]; show: (message: string) => void }) {
  const router = useRouter();
  // `editing` is the group being changed, "new" for one being made, null when the dialog is shut.
  const [editing, setEditing] = useState<GroupInfo | "new" | null>(null);
  const [name, setName] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shake, setShake] = useState(0);

  const start = (group: GroupInfo | "new") => {
    setName(group === "new" ? "" : group.name);
    setMembers(group === "new" ? [] : group.account_ids);
    setError(null);
    setEditing(group);
  };

  const toggle = (id: string) => setMembers((now) => (now.includes(id) ? now.filter((x) => x !== id) : [...now, id]));

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      const body = JSON.stringify({ name, account_ids: members });
      const saved = await api<GroupInfo>(editing === "new" ? "/groups" : `/groups/${editing.id}`, { method: editing === "new" ? "POST" : "PATCH", body });
      setEditing(null);
      show(editing === "new" ? `Created the group ${saved.name}.` : `Saved ${saved.name}.`);
      router.refresh();
    } catch (cause) {
      setError((cause as Error).message);
      setShake((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  async function remove(group: GroupInfo) {
    if (!window.confirm(`Delete the group "${group.name}"? Its accounts stay connected.`)) return;
    try {
      await api(`/groups/${group.id}`, { method: "DELETE" });
      show(`Deleted the group ${group.name}.`);
      router.refresh();
    } catch (cause) {
      show((cause as Error).message);
    }
  }

  return (
    <section className="mt-12" aria-label="Account groups">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="title text-2xl">Groups</h2>
        {groups.length ? (
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => start("new")}>
            <Icon name="plus" size={16} /> New group
          </button>
        ) : null}
      </div>

      {groups.length === 0 ? (
        <div className="panel mt-4 p-6">
          <p className="title text-lg">No groups yet.</p>
          <p className="note mt-2 max-w-xl">A group is a named set of accounts, such as Launch day or Dev channels. Pick it in the composer and exactly those accounts are selected.</p>
          <button type="button" className="btn btn-sm mt-4" onClick={() => start("new")}>
            <Icon name="plus" size={16} /> New group
          </button>
        </div>
      ) : (
        <ul className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-2">
          {groups.map((group) => (
            <li key={group.id} className="panel flex flex-wrap items-center gap-3 p-4">
              <span className="min-w-0 flex-1 basis-40">
                <span className="block truncate font-medium">{group.name}</span>
                {group.accounts.length === 0 ? (
                  <span className="mt-1 block text-sm text-bad">No accounts left. Edit it to add some.</span>
                ) : (
                  <span className="mt-1.5 flex min-w-0 items-center gap-2">
                    <span className="flex flex-none items-center" aria-hidden="true">
                      {group.accounts.slice(0, 6).map((account, i) => (
                        <span key={account.id} style={{ marginLeft: i ? -6 : 0, outline: "2px solid var(--paper)", borderRadius: 8 }}>
                          <Stamp platform={account.platform} />
                        </span>
                      ))}
                    </span>
                    <span className="note truncate">{`${group.accounts.length === 1 ? "1 account" : `${group.accounts.length} accounts`}: ${group.accounts.map((a) => a.handle).join(", ")}`}</span>
                  </span>
                )}
              </span>
              <span className="flex flex-none items-center">
                <button type="button" className="btn btn-bare btn-sm" onClick={() => start(group)} aria-label={`Edit the group ${group.name}`}>
                  Edit
                </button>
                <button type="button" className="btn btn-bare btn-sm" onClick={() => remove(group)} aria-label={`Delete the group ${group.name}`}>
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing === "new" ? "New group" : "Edit group"}>
        <form onSubmit={save} key={shake} className={shake && error ? "is-shaking" : ""}>
          <label className="label" htmlFor="group-name">
            Name
          </label>
          <input id="group-name" className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Launch day" maxLength={60} autoComplete="off" data-autofocus required />
          <p className="label mt-5">Accounts in this group</p>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Accounts in this group">
            {accounts.map((account) => (
              <button key={account.id} type="button" className="chip" aria-pressed={members.includes(account.id)} onClick={() => toggle(account.id)}>
                <Stamp platform={account.platform} />
                <span className="max-w-44 truncate">{account.handle}</span>
              </button>
            ))}
          </div>
          {error ? (
            <p className="mt-4 text-sm font-medium text-bad" role="alert">
              {error}
            </p>
          ) : null}
          <div className="mt-6 flex justify-end gap-2">
            <button type="button" className="btn btn-quiet" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-signal" disabled={busy || members.length === 0 || !name.trim()}>
              {busy ? <span className="spinner" /> : null}
              {busy ? "Saving" : editing === "new" ? "Create group" : "Save group"}
            </button>
          </div>
        </form>
      </Dialog>
    </section>
  );
}
