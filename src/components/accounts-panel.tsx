"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CredentialField, Limits } from "@/lib/platforms/types";
import { api, CopyButton, Dialog, Icon, Stamp, Time, useHydrated, useToast } from "./ui";

type Account = { id: string; platform: string; label: string; handle: string; status: string; last_error: string | null; created_at: string };
type Platform = { id: string; name: string; docs_url: string; setup: string[]; fields: CredentialField[]; limits: Limits; oauth: { callback_path: string; scopes: string[] } | null };

export function AccountsPanel({ accounts, platforms, open, hasPublicUrl, notice }: { accounts: Account[]; platforms: Platform[]; open?: string; hasPublicUrl: boolean; notice?: { ok: boolean; text: string } }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const { show, toast } = useToast();
  const [connecting, setConnecting] = useState<Platform | null>(() => platforms.find((p) => p.id === open) ?? null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shake, setShake] = useState(0);

  const start = (platform: Platform) => {
    setValues({});
    setError(null);
    setConnecting(platform);
  };

  async function connect(event: React.FormEvent) {
    event.preventDefault();
    if (!connecting) return;
    setBusy(true);
    setError(null);
    if (connecting.oauth) {
      // Signing in: Broadside keeps the key and secret for ten minutes while you approve on the network's own page.
      try {
        const { url } = await api<{ url: string }>(`/oauth/${connecting.id}/start`, { method: "POST", body: JSON.stringify({ credentials: values }) });
        window.location.href = url;
      } catch (cause) {
        setError((cause as Error).message);
        setShake((n) => n + 1);
        setBusy(false);
      }
      return;
    }
    try {
      const account = await api<Account>("/accounts", { method: "POST", body: JSON.stringify({ platform: connecting.id, credentials: values }) });
      setConnecting(null);
      show(`Connected ${account.handle}.`);
      router.replace("/app/accounts");
      router.refresh();
    } catch (cause) {
      setError((cause as Error).message);
      setShake((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(account: Account) {
    if (!window.confirm(`Disconnect ${account.handle}? Its stored credentials are deleted. Posts already published stay on ${account.label}.`)) return;
    try {
      await api(`/accounts/${account.id}`, { method: "DELETE" });
      show(`Disconnected ${account.handle}.`);
      router.refresh();
    } catch (cause) {
      show((cause as Error).message);
    }
  }

  return (
    <div>
      <h1 className="heading text-4xl">Accounts</h1>

      {notice ? (
        <p className="sheet mt-6 text-[15px]" role="status" style={{ boxShadow: `inset 0 0 0 1px ${notice.ok ? "var(--good)" : "var(--bad)"}` }}>
          {notice.text}
        </p>
      ) : null}

      <section className="mt-6" aria-label="Connected accounts">
        {accounts.length === 0 ? (
          <div className="panel p-8">
            <p className="title text-xl">No accounts connected.</p>
            <p className="note mt-2 max-w-lg">Pick a network below. You create the credentials yourself, and Broadside encrypts them on this machine.</p>
          </div>
        ) : (
          <ul className="grid gap-2 md:grid-cols-2">
            {accounts.map((account) => (
              <li key={account.id} className="panel flex items-center gap-3 p-4">
                <Stamp platform={account.platform} large />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{account.handle}</span>
                  <span className="note block truncate">
                    {account.label}, connected <Time iso={account.created_at} />
                  </span>
                  {account.status === "needs_attention" ? <span className="mt-1 block text-sm text-bad">{account.last_error ?? "This account needs reconnecting."}</span> : null}
                </span>
                <button type="button" className="btn btn-bare btn-sm" onClick={() => disconnect(account)}>
                  Disconnect
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-12" aria-label="Add an account">
        <h2 className="title text-2xl">Add an account</h2>
        <ul className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {platforms.map((platform) => (
            <li key={platform.id}>
              <button type="button" className="chip w-full justify-start" style={{ borderRadius: "var(--r-2)", minHeight: 56, padding: "8px 12px" }} onClick={() => start(platform)}>
                <Stamp platform={platform.id} />
                <span className="truncate">{platform.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <Dialog open={connecting !== null} onClose={() => setConnecting(null)} title={connecting ? `Connect ${connecting.name}` : "Connect"}>
        {connecting ? (
          <form onSubmit={connect} key={shake} className={shake && error ? "is-shaking" : ""}>
            <ol className="list-decimal space-y-1.5 pl-5 text-[15px] leading-snug text-ink-2">
              {connecting.setup.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ol>
            {connecting.docs_url ? (
              <a className="link mt-3 inline-flex items-center gap-1 text-sm" href={connecting.docs_url} target="_blank" rel="noreferrer">
                Where to get these <Icon name="out" size={14} />
              </a>
            ) : null}
            {connecting.limits.pullsMedia && !hasPublicUrl ? (
              <p className="mt-3 rounded-md bg-paper-2 p-3 text-sm leading-snug">
                {connecting.name} fetches media from a public address. Text posts work now; to send uploaded media, set BROADSIDE_PUBLIC_URL to where this app is reachable from the internet.
              </p>
            ) : null}
            {connecting.oauth ? (
              <div className="mt-4 rounded-md bg-paper-2 p-3 text-sm leading-snug">
                <p className="font-medium">Redirect address to add in your {connecting.name} app</p>
                <div className="mt-2 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate font-mono text-[13px]">{hydrated ? `${window.location.origin}${connecting.oauth.callback_path}` : connecting.oauth.callback_path}</code>
                  {hydrated ? <CopyButton text={`${window.location.origin}${connecting.oauth.callback_path}`} /> : null}
                </div>
              </div>
            ) : null}
            <div className="mt-5 space-y-4">
              {connecting.fields.map((field, i) => (
                <div key={field.key}>
                  <label className="label" htmlFor={`field-${field.key}`}>
                    {field.label}
                    {field.optional ? <span className="note font-normal"> (optional)</span> : null}
                  </label>
                  <input
                    id={`field-${field.key}`}
                    className="field"
                    type={field.kind === "secret" ? "password" : field.kind === "url" ? "url" : "text"}
                    placeholder={field.placeholder}
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus={i === 0}
                    required={!field.optional}
                    value={values[field.key] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                  />
                  {field.help ? <p className="note mt-1">{field.help}</p> : null}
                </div>
              ))}
            </div>
            {error ? (
              <p className="mt-4 text-sm font-medium text-bad" role="alert">
                {error}
              </p>
            ) : null}
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" className="btn btn-quiet" onClick={() => setConnecting(null)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-signal" disabled={busy}>
                {busy ? <span className="spinner" /> : null}
                {connecting.oauth ? (busy ? "Opening" : `Continue with ${connecting.name}`) : busy ? "Checking" : "Connect"}
              </button>
            </div>
          </form>
        ) : null}
      </Dialog>
      {toast}
    </div>
  );
}
