"use client";

import { useState } from "react";

/** The invited person chooses their own password. Nobody else ever sees or sets it. */
export function JoinForm({ token, name, min }: { token: string; name: string; min: number }) {
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(0);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (password !== again) {
      setError("The two passwords are not the same. Type the password again.");
      setShake((n) => n + 1);
      return;
    }
    setBusy(true);
    setError(null);
    const response = await fetch("/api/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, password }) });
    if (response.ok) {
      // A full load, so the address with the token in it is replaced and nothing from this page stays in memory.
      window.location.replace("/app");
      return;
    }
    const payload = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    setError(payload.error?.message ?? "Could not set the password. Try again.");
    setShake((n) => n + 1);
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className={`mt-6 ${shake ? "is-shaking" : ""}`} key={shake}>
      {/* Lets a password manager file the new password under the right name. */}
      <input type="text" name="username" autoComplete="username" value={name} readOnly hidden />
      <label className="label" htmlFor="join-password">
        Password
      </label>
      <input id="join-password" type="password" className="field" autoComplete="new-password" autoFocus required minLength={min} value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={error ? true : undefined} aria-describedby="join-rule" />
      <p id="join-rule" className="note mt-2">{`At least ${min} characters. A few unrelated words work well.`}</p>
      <label className="label mt-4" htmlFor="join-again">
        Password again
      </label>
      <input id="join-again" type="password" className="field" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} />
      {error ? (
        <p className="mt-2 text-sm font-medium text-bad" role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" className="btn btn-signal mt-4 w-full" disabled={busy}>
        {busy ? <span className="spinner" /> : null}
        Set password and sign in
      </button>
    </form>
  );
}
