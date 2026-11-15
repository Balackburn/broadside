"use client";

import { useState } from "react";

export function LoginForm({ next }: { next: string }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(0);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const response = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
    if (response.ok) {
      window.location.assign(next);
      return;
    }
    const payload = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    setError(payload.error?.message ?? "Could not sign in.");
    setShake((n) => n + 1);
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className={`mt-6 ${shake ? "is-shaking" : ""}`} key={shake}>
      <label className="label" htmlFor="password">
        Password
      </label>
      <input id="password" type="password" className="field" autoComplete="current-password" autoFocus required value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={error ? true : undefined} />
      {error ? (
        <p className="mt-2 text-sm font-medium text-bad" role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" className="btn btn-signal mt-4 w-full" disabled={busy}>
        {busy ? <span className="spinner" /> : null}
        Sign in
      </button>
    </form>
  );
}
