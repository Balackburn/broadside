"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { manages, rank, ROLES, type Role } from "@/lib/roles";
import { api, CopyButton, Tabs, Time, useToast } from "./ui";

type Key = { id: string; name: string; prefix: string; created_at: string; last_used_at: string | null; member_id?: string | null; role?: Role | null; owner?: string | null; owner_role?: Role | null };
type Client = "claude-code" | "json" | "stdio" | "curl";

const TOOLS: [string, string][] = [
  ["list_platforms", "Every network, its limits and what it needs to connect"],
  ["list_accounts", "The accounts this Broadside can post to"],
  ["list_groups", "Saved groups of accounts, to post to one by its id"],
  ["connect_account", "A link where you enter the credentials yourself"],
  ["upload_media", "Add an image or video by URL, bytes or local path"],
  ["list_media", "The media library, with where each file is used"],
  ["list_tags", "The tags posts carry, to tag or filter by"],
  ["list_signatures", "Saved sign-offs and hashtag sets to end a post with"],
  ["check_post", "Dry run: does this fit each network?"],
  ["create_post", "Publish now, schedule, or save a draft"],
  ["get_post", "Per-network status and public links"],
  ["list_posts", "History, filtered by status, tag or date"],
  ["update_post", "Change a draft or scheduled post"],
  ["publish_post", "Send a draft or scheduled post now"],
  ["cancel_post", "Stop a scheduled post"],
  ["retry_target", "Resend to one network that failed"],
  ["list_feeds", "The feeds Broadside reads, to look at only"],
  ["list_outgoing_webhooks", "The outgoing webhooks, to look at only"],
];

/** `team` is the member looking, when the install has a team: a new key is then theirs, with a role they choose up to their own. */
export function KeysPanel({ keys, base, cwd, team }: { keys: Key[]; base: string; cwd: string; team?: { id: string; role: Role } }) {
  const router = useRouter();
  const { show, toast } = useToast();
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [client, setClient] = useState<Client>("claude-code");
  const [role, setRole] = useState<Role>("editor");
  const offered = team ? ROLES.filter((r) => rank(r) <= rank(team.role)) : [];
  // An admin revokes their own keys, keys from before the team, and those of editors and viewers. The server holds the same line.
  const canRevoke = (key: Key) => !team || !key.member_id || key.member_id === team.id || !key.owner_role || manages(team.role, key.owner_role);
  const token = fresh ?? "bs_your_key";

  const snippets: Record<Client, string> = {
    "claude-code": `claude mcp add --transport http broadside \\\n  ${base}/mcp \\\n  --header "Authorization: Bearer ${token}"`,
    json: JSON.stringify({ mcpServers: { broadside: { type: "http", url: `${base}/mcp`, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
    stdio: JSON.stringify({ mcpServers: { broadside: { command: "npx", args: ["tsx", `${cwd}/bin/broadside-mcp.ts`], env: { BROADSIDE_DATA_DIR: `${cwd}/data` } } } }, null, 2),
    curl: `curl ${base}/api/v1/posts \\\n  -H "Authorization: Bearer ${token}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"content": "Hello from the API", "targets": [{"account_id": "acc_…"}]}'`,
  };
  const hints: Record<Client, string> = {
    "claude-code": "Run this in a terminal. Claude Code then has Broadside's tools in every session.",
    json: "For Claude Desktop, Cursor and other clients that read an mcpServers file.",
    stdio: team
      ? "Runs on this machine and can read media straight from your disk. With a team it works as an editor that belongs to no one, unless BROADSIDE_API_KEY in its env holds a member's key."
      : "Runs on this machine without a key, and can read media straight from your disk.",
    curl: "The same engine over plain HTTP, for scripts and automations.",
  };

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const made = await api<{ token: string }>("/keys", { method: "POST", body: JSON.stringify(team ? { name, role } : { name }) });
      setFresh(made.token);
      setName("");
      router.refresh();
    } catch (error) {
      show((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(key: Key) {
    if (!window.confirm(`Revoke "${key.name}"? Anything using this key stops working at once.`)) return;
    try {
      await api(`/keys/${key.id}`, { method: "DELETE" });
      show("Key revoked.");
      router.refresh();
    } catch (error) {
      show((error as Error).message);
    }
  }

  return (
    <div>
      <h1 className="heading text-4xl">Connect</h1>
      <p className="mt-3 max-w-2xl text-lg leading-snug text-ink-2">Give an AI agent or a script the same reach as this app. Create a key, then point your client at the endpoint.</p>

      <div className="mt-8 grid gap-10 xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <section aria-label="API keys">
          <h2 className="title text-2xl">Keys</h2>
          <form onSubmit={create} className={team ? "mt-4 flex flex-wrap gap-2" : "mt-4 flex gap-2"}>
            <label className="sr-only" htmlFor="key-name">
              Key name
            </label>
            <input id="key-name" className={team ? "field min-w-48 flex-1" : "field"} placeholder="Name it, for example Claude Code" value={name} onChange={(e) => setName(e.target.value)} />
            {team ? (
              <>
                <label className="sr-only" htmlFor="key-role">
                  Role for the key
                </label>
                <select id="key-role" className="field w-auto flex-none" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                  {offered.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </>
            ) : null}
            <button type="submit" className="btn flex-none" disabled={busy}>
              Create key
            </button>
          </form>
          {team ? <p className="note mt-2">A key is yours and can do what its role allows, never more than you can. If your role is lowered or you are disabled, so is the key.</p> : null}

          {fresh ? (
            <div className="sheet mt-4" style={{ boxShadow: "inset 0 0 0 2px var(--signal)" }}>
              <p className="font-medium">Copy this key now. It is shown once.</p>
              <div className="mt-3 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md bg-paper-2 px-3 py-2 font-mono text-sm">{fresh}</code>
                <CopyButton text={fresh} />
              </div>
              <p className="note mt-3">The snippets on this page now include it.</p>
            </div>
          ) : null}

          {keys.length === 0 ? (
            <p className="note panel mt-4 p-6">No keys yet. The local stdio server works without one.</p>
          ) : (
            <ul className="mt-4 space-y-2">
              {keys.map((key) => (
                <li key={key.id} className="panel flex items-center gap-3 p-4">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{key.name}</span>
                    {team ? (
                      <span className="note block truncate">
                        {key.member_id ? `${key.owner ?? "A removed member"}, ${key.role ?? "viewer"}` : "Created before the team. Works as an editor and belongs to no one."}
                      </span>
                    ) : null}
                    <span className="note num block truncate">
                      <code className="font-mono text-[13px]">{key.prefix}…</code> {key.last_used_at ? (
                        <>
                          last used <Time iso={key.last_used_at} />
                        </>
                      ) : (
                        "never used"
                      )}
                    </span>
                  </span>
                  {canRevoke(key) ? (
                    <button type="button" className="btn btn-bare btn-sm" onClick={() => revoke(key)}>
                      Revoke
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Client setup">
          <h2 className="title text-2xl">Set up a client</h2>
          <div className="scroll-quiet mt-4 max-w-full">
            <Tabs
              label="Client"
              value={client}
              onChange={setClient}
              options={[
                { value: "claude-code", label: "Claude Code" },
                { value: "json", label: "Config file" },
                { value: "stdio", label: "Local stdio" },
                { value: "curl", label: "REST" },
              ]}
            />
          </div>
          <p className="note mt-3">{hints[client]}</p>
          <pre className="code mt-3" key={client}>
            {snippets[client]}
          </pre>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <p className="note">
              Endpoint <code className="font-mono text-[13px]">{base}/mcp</code>, Streamable HTTP
            </p>
            <CopyButton text={snippets[client]} label="Copy snippet" />
          </div>
        </section>
      </div>

      <section className="mt-14" aria-label="Tools">
        <h2 className="title text-2xl">What an agent can do</h2>
        <ul className="mt-4 grid gap-x-10 sm:grid-cols-2">
          {TOOLS.map(([tool, does], i) => (
            <li key={tool} className={`flex flex-wrap items-baseline gap-x-3 rounded-md px-3 py-2.5 ${Math.floor(i / 2) % 2 ? "" : "bg-paper-2"}`}>
              <code className="font-mono text-[13.5px] font-medium">{tool}</code>
              <span className="note">{does}</span>
            </li>
          ))}
        </ul>
      </section>
      {toast}
    </div>
  );
}
