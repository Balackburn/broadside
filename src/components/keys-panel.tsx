"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, CopyButton, Tabs, Time, useToast } from "./ui";

type Key = { id: string; name: string; prefix: string; created_at: string; last_used_at: string | null };
type Client = "claude-code" | "json" | "stdio" | "curl";

const TOOLS: [string, string][] = [
  ["list_platforms", "Every network, its limits and what it needs to connect"],
  ["list_accounts", "The accounts this Broadside can post to"],
  ["connect_account", "A link where you enter the credentials yourself"],
  ["upload_media", "Add an image or video by URL, bytes or local path"],
  ["check_post", "Dry run: does this fit each network?"],
  ["create_post", "Publish now, schedule, or save a draft"],
  ["get_post", "Per-network status and public links"],
  ["list_posts", "History, filtered by status or date"],
  ["update_post", "Change a draft or scheduled post"],
  ["publish_post", "Send a draft or scheduled post now"],
  ["cancel_post", "Stop a scheduled post"],
  ["retry_target", "Resend to one network that failed"],
];

export function KeysPanel({ keys, base, cwd }: { keys: Key[]; base: string; cwd: string }) {
  const router = useRouter();
  const { show, toast } = useToast();
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [client, setClient] = useState<Client>("claude-code");
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
    stdio: "Runs on this machine without a key, and can read media straight from your disk.",
    curl: "The same engine over plain HTTP, for scripts and automations.",
  };

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const made = await api<{ token: string }>("/keys", { method: "POST", body: JSON.stringify({ name }) });
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
          <form onSubmit={create} className="mt-4 flex gap-2">
            <label className="sr-only" htmlFor="key-name">
              Key name
            </label>
            <input id="key-name" className="field" placeholder="Name it, for example Claude Code" value={name} onChange={(e) => setName(e.target.value)} />
            <button type="submit" className="btn flex-none" disabled={busy}>
              Create key
            </button>
          </form>

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
                  <button type="button" className="btn btn-bare btn-sm" onClick={() => revoke(key)}>
                    Revoke
                  </button>
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
