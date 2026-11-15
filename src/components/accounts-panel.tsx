"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CredentialField, Limits } from "@/lib/platforms/types";
import { redirectAddress } from "@/lib/redirect";
import { GroupsPanel, type GroupInfo } from "./groups-panel";
import { SignaturesPanel, type SignatureInfo } from "./signatures-panel";
import { api, Check, CopyButton, Dialog, Icon, Stamp, Time, useHydrated, useToast } from "./ui";

type Account = { id: string; platform: string; label: string; handle: string; status: string; last_error: string | null; signature_id: string | null; created_at: string };
type SignIn = { callback_path: string; scopes: string[]; loopback: "localhost" | "127.0.0.1" | null; https_only: boolean; paste: CredentialField[]; paste_help: string | null };
type Platform = { id: string; name: string; docs_url: string; setup: string[]; fields: CredentialField[]; limits: Limits; oauth: SignIn | null };
/** What a sign-in left to choose from: Pages, Instagram accounts or boards. */
type Choice = { id: string; platform: string; name: string; prompt: string; multiple: boolean; choices: { id: string; name: string; detail?: string }[] };

const LOOPBACK = ["localhost", "127.0.0.1"];

export function AccountsPanel({
  accounts,
  platforms,
  groups,
  signatures,
  open,
  publicUrl,
  notice,
  choice,
}: {
  accounts: Account[];
  platforms: Platform[];
  groups: GroupInfo[];
  signatures: SignatureInfo[];
  open?: string;
  publicUrl: string | null;
  notice?: { ok: boolean; text: string };
  choice?: Choice;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const { show, toast } = useToast();
  const [connecting, setConnecting] = useState<Platform | null>(() => platforms.find((p) => p.id === open) ?? null);
  const [pasting, setPasting] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  const [choosing, setChoosing] = useState<Choice | null>(choice ?? null);
  // With one thing on offer it starts picked, so connecting it is one press.
  const [picked, setPicked] = useState<string[]>(() => (choice?.choices.length === 1 ? [choice.choices[0].id] : []));

  // The address this Broadside is reached at: the configured public one, else the one in the address bar.
  const origin = publicUrl ?? (hydrated ? window.location.origin : null);
  const signIn = connecting?.oauth ?? null;
  const redirect = connecting && signIn && origin ? redirectAddress(origin, connecting.id, signIn.loopback) : null;
  // A network that takes only https redirect addresses cannot sign in from a plain http Broadside, so its tokens are pasted instead.
  const httpsNeeded = Boolean(signIn?.https_only && redirect && !redirect.startsWith("https://"));
  const pasteMode = Boolean(signIn) && (pasting || httpsNeeded);
  const fields = connecting ? (pasteMode && signIn ? signIn.paste : connecting.fields) : [];
  const renamed = Boolean(signIn?.loopback && origin && LOOPBACK.includes(new URL(origin).hostname) && new URL(origin).hostname !== signIn.loopback);

  const start = (platform: Platform) => {
    setValues({});
    setError(null);
    setPasting(false);
    setConnecting(platform);
  };

  const swap = () => {
    setValues({});
    setError(null);
    setPasting((on) => !on);
  };

  async function connect(event: React.FormEvent) {
    event.preventDefault();
    if (!connecting) return;
    setBusy(true);
    setError(null);
    if (connecting.oauth && !pasteMode) {
      // Signing in: Broadside keeps the app's id and secret for ten minutes while you approve on the network's own page.
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

  const signatureNames: Record<string, string> = Object.fromEntries(signatures.map((s) => [s.id, s.name]));

  const toggle = (id: string) => setPicked((now) => (choosing?.multiple ? (now.includes(id) ? now.filter((p) => p !== id) : [...now, id]) : [id]));

  const leaveChoice = () => {
    setChoosing(null);
    setError(null);
    router.replace("/app/accounts");
  };

  async function connectPicked(event: React.FormEvent) {
    event.preventDefault();
    if (!choosing || picked.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ connected: Account[]; failed: { name: string; error: string }[] }>(`/oauth/choices/${choosing.id}`, { method: "POST", body: JSON.stringify({ choices: picked }) });
      const missed = result.failed.map((f) => `${f.name} could not be connected: ${f.error}`).join(" ");
      show(`Connected ${result.connected.map((a) => a.handle).join(", ")}.${missed ? ` ${missed}` : ""}`);
      setChoosing(null);
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
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {accounts.map((account) => (
              <li key={account.id} className="panel flex items-center gap-3 p-4">
                <Stamp platform={account.platform} large />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{account.handle}</span>
                  <span className="note block truncate">
                    {account.label}, connected <Time iso={account.created_at} />
                  </span>
                  {signatureNames[account.signature_id ?? ""] ? <span className="note block truncate">{`Offers the signature ${signatureNames[account.signature_id ?? ""]}`}</span> : null}
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

      {/* A group is made of connected accounts, so the section appears once there is one to put in it. */}
      {accounts.length ? <GroupsPanel accounts={accounts} groups={groups} show={show} /> : null}

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

      <SignaturesPanel accounts={accounts} signatures={signatures} show={show} />

      <Dialog open={connecting !== null} onClose={() => setConnecting(null)} title={connecting ? `Connect ${connecting.name}` : "Connect"}>
        {connecting ? (
          <form onSubmit={connect} key={`${shake}-${pasteMode}`} className={shake && error ? "is-shaking" : ""}>
            {httpsNeeded && origin ? (
              <p className="mb-3 rounded-md bg-paper-2 p-3 text-sm leading-snug">
                {connecting.name} only accepts an https redirect address, and this Broadside is at {origin}. Paste a token here, or set BROADSIDE_PUBLIC_URL to an https address to sign in with {connecting.name}.
              </p>
            ) : null}
            {pasteMode && signIn?.paste_help ? (
              <p className="text-[15px] leading-snug text-ink-2">{signIn.paste_help}</p>
            ) : (
              <ol className="list-decimal space-y-1.5 pl-5 text-[15px] leading-snug text-ink-2">
                {connecting.setup.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ol>
            )}
            {connecting.docs_url ? (
              <a className="link mt-3 inline-flex items-center gap-1 text-sm" href={connecting.docs_url} target="_blank" rel="noreferrer">
                Where to get these <Icon name="out" size={14} />
              </a>
            ) : null}
            {connecting.limits.pullsMedia && !publicUrl ? (
              <p className="mt-3 rounded-md bg-paper-2 p-3 text-sm leading-snug">
                {connecting.name} fetches media from a public address. Text posts work now; to send uploaded media, set BROADSIDE_PUBLIC_URL to where this app is reachable from the internet.
              </p>
            ) : null}
            {signIn && !pasteMode ? (
              <div className="mt-4 rounded-md bg-paper-2 p-3 text-sm leading-snug">
                <p className="font-medium">Redirect address to add in your {connecting.name} app</p>
                <div className="mt-2 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate font-mono text-[13px]">{redirect ?? signIn.callback_path}</code>
                  {redirect ? <CopyButton text={redirect} /> : null}
                </div>
                {renamed ? (
                  <p className="note mt-2">
                    {connecting.name} accepts only {signIn.loopback} as the name of this machine. Broadside answers to it too, so add the address exactly as shown.
                  </p>
                ) : null}
                <p className="mt-3 font-medium">Permissions it will ask for</p>
                <p className="mt-1 font-mono text-[13px] break-words">{signIn.scopes.join(", ")}</p>
              </div>
            ) : null}
            <div className="mt-5 space-y-4">
              {fields.map((field, i) => (
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
            <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
              {signIn && !httpsNeeded ? (
                <button type="button" className="link mr-auto text-sm" onClick={swap}>
                  {pasteMode ? `Sign in with ${connecting.name} instead` : "Paste tokens instead"}
                </button>
              ) : null}
              <button type="button" className="btn btn-quiet" onClick={() => setConnecting(null)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-signal" disabled={busy}>
                {busy ? <span className="spinner" /> : null}
                {signIn && !pasteMode ? (busy ? "Opening" : `Continue with ${connecting.name}`) : busy ? "Checking" : "Connect"}
              </button>
            </div>
          </form>
        ) : null}
      </Dialog>

      <Dialog open={choosing !== null} onClose={leaveChoice} title={choosing ? `Connect ${choosing.name}` : "Connect"}>
        {choosing ? (
          <form onSubmit={connectPicked} key={shake} className={shake && error ? "is-shaking" : ""}>
            <p className="text-[15px] leading-snug text-ink-2">{choosing.prompt}</p>
            <ul className="mt-4 space-y-2" aria-label={choosing.prompt}>
              {choosing.choices.map((option) => {
                const on = picked.includes(option.id);
                return (
                  <li key={option.id}>
                    <button type="button" className="chip w-full justify-start" aria-pressed={on} style={{ borderRadius: "var(--r-2)", minHeight: 56, padding: "8px 12px" }} onClick={() => toggle(option.id)}>
                      <Stamp platform={choosing.platform} />
                      <span className="min-w-0 flex-1 text-left">
                        <span className="block truncate">{option.name}</span>
                        {option.detail ? <span className="note block truncate">{option.detail}</span> : null}
                      </span>
                      {on ? <Check /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
            {error ? (
              <p className="mt-4 text-sm font-medium text-bad" role="alert">
                {error}
              </p>
            ) : null}
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" className="btn btn-quiet" onClick={leaveChoice}>
                Cancel
              </button>
              <button type="submit" className="btn btn-signal" disabled={busy || picked.length === 0}>
                {busy ? <span className="spinner" /> : null}
                {busy ? "Connecting" : picked.length > 1 ? `Connect ${picked.length}` : "Connect"}
              </button>
            </div>
          </form>
        ) : null}
      </Dialog>
      {toast}
    </div>
  );
}
