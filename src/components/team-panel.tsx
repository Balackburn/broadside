"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { grants, manages, ROLE_WORDS, ROLES, type Role } from "@/lib/roles";
import { api, CopyButton, Dialog, Icon, Time, useToast } from "./ui";

type Member = { id: string; name: string; role: Role; created_at: string; disabled_at: string | null; last_seen_at: string | null };
type Invite = { id: string; name: string; role: Role; created_at: string; expires_at: string; reset: boolean; invited_by: string | null };
type Me = { id: string; name: string; role: Role };

const ROLES_DOWN = [...ROLES].reverse();

function RolesList() {
  return (
    <dl className="mt-4 space-y-2">
      {ROLES_DOWN.map((role) => (
        <div key={role} className="panel p-4">
          <dt className="font-medium">{role}</dt>
          <dd className="note mt-1">{ROLE_WORDS[role]}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Two password fields that must agree. The rule is said before it is broken, and the server checks it again. */
function NewPassword({ id, value, again, onValue, onAgain, min, label = "Password" }: { id: string; value: string; again: string; onValue: (v: string) => void; onAgain: (v: string) => void; min: number; label?: string }) {
  return (
    <>
      <label className="label mt-4" htmlFor={id}>
        {label}
      </label>
      <input id={id} type="password" className="field" autoComplete="new-password" required minLength={min} value={value} onChange={(e) => onValue(e.target.value)} aria-describedby={`${id}-rule`} />
      <p id={`${id}-rule`} className="note mt-2">{`At least ${min} characters. A few unrelated words work well.`}</p>
      <label className="label mt-4" htmlFor={`${id}-again`}>
        {`${label} again`}
      </label>
      <input id={`${id}-again`} type="password" className="field" autoComplete="new-password" required value={again} onChange={(e) => onAgain(e.target.value)} />
    </>
  );
}

/** Shows a form's error under its fields and shakes the form once each time one arrives. */
function useFormError() {
  const [error, setError] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  return {
    error,
    shake,
    clear: () => setError(null),
    fail: (message: string) => {
      setError(message);
      setShake((n) => n + 1);
    },
  };
}

function FormError({ text }: { text: string | null }) {
  return text ? (
    <p className="mt-3 text-sm font-medium text-bad" role="alert">
      {text}
    </p>
  ) : null;
}

/** No team yet: what one is, and the form that starts it. Whoever fills it in becomes the owner. */
function StartTeam({ sharedPassword, passwordMin }: { sharedPassword: boolean; passwordMin: number }) {
  const form = useFormError();
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (password !== again) return form.fail("The two passwords are not the same. Type the password again.");
    setBusy(true);
    form.clear();
    try {
      await api("/team", { method: "POST", body: JSON.stringify({ name, password }) });
      // A full load: the session is now the new owner's, and nothing from before it should stay in memory.
      window.location.replace("/app/team");
    } catch (cause) {
      form.fail((cause as Error).message);
      setBusy(false);
    }
  }

  return (
    <div>
      <h1 className="heading text-4xl">Team</h1>
      <p className="mt-3 max-w-2xl text-lg leading-snug text-ink-2">Let other people use this Broadside, each with their own sign-in and a role that says what they can do.</p>

      <div className="mt-8 grid gap-10 xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <section aria-label="Set up a team">
          <h2 className="title text-2xl">Set up a team</h2>
          <p className="note mt-2">
            You become the owner. From then on everyone signs in as a member with their own password, on this machine too
            {sharedPassword ? ", and the shared password no longer signs anyone in" : ""}. Until you do this, nothing about this Broadside changes.
          </p>
          <form onSubmit={submit} key={form.shake} className={`panel mt-4 p-5 ${form.shake && form.error ? "is-shaking" : ""}`}>
            <label className="label" htmlFor="team-name">
              Your name
            </label>
            <input id="team-name" className="field" autoComplete="username" required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder="The name you will sign in with" />
            <NewPassword id="team-password" value={password} again={again} onValue={setPassword} onAgain={setAgain} min={passwordMin} />
            <FormError text={form.error} />
            <button type="submit" className="btn btn-signal mt-5" disabled={busy || !name.trim() || !password || !again}>
              {busy ? <span className="spinner" /> : null}
              Set up a team
            </button>
          </form>
          <ul className="note mt-4 list-disc space-y-1.5 pl-5">
            <li>Your posts, accounts, media and automations stay as they are.</li>
            <li>API keys you already have keep working as editors that belong to no one: they can still post, and cannot connect accounts, make keys or change automations. Revoke the ones you no longer need under Connect.</li>
            <li>
              {"If you forget your password, run "}
              <code className="font-mono text-[13px]">{"npm run members -- reset <name>"}</code>
              {" on the server for a new link. "}
              <code className="font-mono text-[13px]">npm run members -- leave-team --yes</code>
              {" goes back to one operator."}
            </li>
          </ul>
        </section>

        <section aria-label="Roles">
          <h2 className="title text-2xl">Roles</h2>
          <p className="note mt-2">Each role can do everything the ones below it can.</p>
          <RolesList />
        </section>
      </div>
    </div>
  );
}

/** A member changes their own password. It asks for the current one, and signs every other device out. */
function OwnPassword({ name, passwordMin, show }: { name: string; passwordMin: number; show: (message: string) => void }) {
  const form = useFormError();
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (password !== again) return form.fail("The two new passwords are not the same. Type the new password again.");
    setBusy(true);
    form.clear();
    try {
      await api("/team/password", { method: "POST", body: JSON.stringify({ current, next: password }) });
      setCurrent("");
      setPassword("");
      setAgain("");
      show("Password changed. You are signed out everywhere else.");
    } catch (cause) {
      form.fail((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Your password">
      <h2 className="title text-2xl">Your password</h2>
      <p className="note mt-2">Changing it signs you out on every other device. Nobody else can see or set your password.</p>
      <form onSubmit={submit} key={form.shake} className={`panel mt-4 p-5 ${form.shake && form.error ? "is-shaking" : ""}`}>
        {/* Lets a password manager file the new password under the right name. */}
        <input type="text" name="username" autoComplete="username" value={name} readOnly hidden />
        <label className="label" htmlFor="current-password">
          Current password
        </label>
        <input id="current-password" type="password" className="field" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        <NewPassword id="new-password" label="New password" value={password} again={again} onValue={setPassword} onAgain={setAgain} min={passwordMin} />
        <FormError text={form.error} />
        <button type="submit" className="btn mt-5" disabled={busy || !current || !password || !again}>
          {busy ? <span className="spinner" /> : null}
          Change password
        </button>
      </form>
    </section>
  );
}

/** Asks for a name and a role no higher than the inviter's own, and hands back the one-time link. */
function InviteDialog({ open, onClose, offered, onMade }: { open: boolean; onClose: () => void; offered: Role[]; onMade: (made: { name: string; path: string; url: string | null }) => void }) {
  const form = useFormError();
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>(offered.includes("editor") ? "editor" : offered[0]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    form.clear();
    try {
      const made = await api<{ invite: Invite; path: string; url: string | null }>("/team/invites", { method: "POST", body: JSON.stringify({ name, role }) });
      setName("");
      onMade({ name: made.invite.name, path: made.path, url: made.url });
    } catch (cause) {
      form.fail((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Invite someone">
      <form onSubmit={submit} key={form.shake} className={form.shake && form.error ? "is-shaking" : ""}>
        <label className="label" htmlFor="invite-name">
          Their name
        </label>
        <input id="invite-name" className="field" required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder="The name they will sign in with" autoComplete="off" data-autofocus />
        <label className="label mt-4" htmlFor="invite-role">
          Role
        </label>
        <select id="invite-role" className="field" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {offered.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <p className="note mt-2">{ROLE_WORDS[role]}</p>
        <FormError text={form.error} />
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-signal" disabled={busy || !name.trim()}>
            {busy ? <span className="spinner" /> : null}
            Create invite link
          </button>
        </div>
      </form>
    </Dialog>
  );
}

const A_ROLE: Record<Role, string> = { viewer: "a viewer", editor: "an editor", admin: "an admin", owner: "an owner" };

/**
 * The Team screen. With no team it explains what one is and starts it. With
 * one it lists the members, lets admins invite and manage the people below
 * them, and lets anyone change their own password. Every button here asks the
 * API, which decides again for itself.
 */
export function TeamPanel({
  me,
  members,
  invites,
  publicUrl,
  sharedPassword,
  passwordMin,
  inviteDays,
}: {
  me: Me | null;
  members: Member[];
  invites: Invite[];
  publicUrl: string | null;
  sharedPassword: boolean;
  passwordMin: number;
  inviteDays: number;
}) {
  const router = useRouter();
  const { show, toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  // The link for an invite just made. It is shown this once; the server keeps only a hash of it.
  const [fresh, setFresh] = useState<{ name: string; link: string } | null>(null);

  if (!me) return <StartTeam sharedPassword={sharedPassword} passwordMin={passwordMin} />;

  const admin = grants(me.role, "viewer");
  const offered = ROLES.filter((role) => grants(me.role, role));

  async function act(key: string, work: () => Promise<string>) {
    setBusy(key);
    try {
      show(await work());
      router.refresh();
    } catch (cause) {
      show((cause as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <h1 className="heading text-4xl">Team</h1>
      <p className="mt-3 max-w-2xl text-lg leading-snug text-ink-2">{`You are signed in as ${me.name}, with the ${me.role} role. ${ROLE_WORDS[me.role]}`}</p>

      <section className="mt-8" aria-label="Members">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="title text-2xl">Members</h2>
          {admin ? (
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => setInviting(true)}>
              <Icon name="plus" size={16} /> Invite someone
            </button>
          ) : null}
        </div>

        {fresh ? (
          <div className="sheet mt-4" style={{ boxShadow: "inset 0 0 0 2px var(--signal)" }}>
            <p className="font-medium">{`Copy this link now and send it to ${fresh.name}. It is shown once.`}</p>
            <div className="mt-3 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md bg-paper-2 px-3 py-2 font-mono text-sm">{fresh.link}</code>
              <CopyButton text={fresh.link} />
            </div>
            <p className="note mt-3">{`${fresh.name} opens it, chooses a password and is signed in. It works once and runs out in ${inviteDays} days. Anyone who has the link can use it, so send it somewhere private.`}</p>
            <button type="button" className="btn btn-quiet btn-sm mt-3" onClick={() => setFresh(null)}>
              I have copied it
            </button>
          </div>
        ) : null}

        <ul className="mt-4 space-y-2">
          {members.map((member) => {
            const mine = member.id === me.id;
            const manageable = !mine && manages(me.role, member.role);
            return (
              <li key={member.id} className="panel flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
                <span className="min-w-0 flex-1 basis-48">
                  <span className="block truncate font-medium">
                    {member.name}
                    {mine ? <span className="note font-normal"> (you)</span> : null}
                  </span>
                  <span className="note num block truncate">
                    {member.disabled_at ? (
                      <span className="text-bad">
                        Disabled <Time iso={member.disabled_at} />
                      </span>
                    ) : member.last_seen_at ? (
                      <>
                        Last here <Time iso={member.last_seen_at} />
                      </>
                    ) : (
                      "Has not signed in yet"
                    )}
                  </span>
                </span>
                {manageable ? (
                  <>
                    <label className="sr-only" htmlFor={`role-${member.id}`}>{`Role for ${member.name}`}</label>
                    <select
                      id={`role-${member.id}`}
                      className="field w-auto flex-none text-sm"
                      value={member.role}
                      disabled={busy !== null}
                      onChange={(e) => {
                        const role = e.target.value as Role;
                        void act(`role:${member.id}`, async () => {
                          await api(`/team/members/${member.id}`, { method: "PATCH", body: JSON.stringify({ role }) });
                          return `${member.name} is now ${A_ROLE[role]}.`;
                        });
                      }}
                    >
                      {offered.map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>
                    <span className="flex flex-none items-center">
                      <button
                        type="button"
                        className="btn btn-bare btn-sm"
                        disabled={busy !== null}
                        onClick={() => {
                          if (!member.disabled_at && !window.confirm(`Disable ${member.name}? They are signed out everywhere and their API keys stop working until you enable them again.`)) return;
                          void act(`disable:${member.id}`, async () => {
                            await api(`/team/members/${member.id}`, { method: "PATCH", body: JSON.stringify({ disabled: !member.disabled_at }) });
                            return member.disabled_at ? `${member.name} can sign in again.` : `${member.name} is disabled and signed out.`;
                          });
                        }}
                      >
                        {member.disabled_at ? "Enable" : "Disable"}
                      </button>
                      {member.disabled_at ? (
                        <button
                          type="button"
                          className="btn btn-bare btn-sm"
                          disabled={busy !== null}
                          onClick={() => {
                            if (!window.confirm(`Remove ${member.name} for good? Their API keys are deleted. Posts they wrote stay, without their name. This cannot be undone.`)) return;
                            void act(`remove:${member.id}`, async () => {
                              await api(`/team/members/${member.id}`, { method: "DELETE" });
                              return `${member.name} was removed.`;
                            });
                          }}
                        >
                          Remove
                        </button>
                      ) : null}
                    </span>
                  </>
                ) : (
                  <span className="note flex-none">{member.role}</span>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {admin ? (
        <section className="mt-12" aria-label="Invites">
          <h2 className="title text-2xl">Invites waiting</h2>
          {invites.length === 0 ? (
            <p className="note panel mt-4 p-6">No invites are waiting. An invite is a one-time link: the person who opens it chooses their own password, and nobody else ever sees it.</p>
          ) : (
            <ul className="mt-4 space-y-2">
              {invites.map((waiting) => (
                <li key={waiting.id} className="panel flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
                  <span className="min-w-0 flex-1 basis-48">
                    <span className="block truncate font-medium">{waiting.name}</span>
                    <span className="note num block truncate">
                      {waiting.reset ? "A new password link, made on the server" : `Invited as ${waiting.role}${waiting.invited_by ? ` by ${waiting.invited_by}` : ""}`}, runs out <Time iso={waiting.expires_at} />
                    </span>
                  </span>
                  {grants(me.role, waiting.role) ? (
                    <button
                      type="button"
                      className="btn btn-bare btn-sm"
                      disabled={busy !== null}
                      onClick={() =>
                        act(`revoke:${waiting.id}`, async () => {
                          await api(`/team/invites/${waiting.id}`, { method: "DELETE" });
                          return `The link for ${waiting.name} no longer works.`;
                        })
                      }
                    >
                      Revoke
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <div className="mt-12 grid gap-10 xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <OwnPassword name={me.name} passwordMin={passwordMin} show={show} />
        <section aria-label="Roles">
          <h2 className="title text-2xl">Roles</h2>
          <p className="note mt-2">Each role can do everything the ones below it can. There is always at least one owner.</p>
          <RolesList />
        </section>
      </div>

      {admin ? (
        <InviteDialog
          open={inviting}
          onClose={() => setInviting(false)}
          offered={offered}
          onMade={(made) => {
            setFresh({ name: made.name, link: made.url ?? `${publicUrl ?? window.location.origin}${made.path}` });
            setInviting(false);
            router.refresh();
          }}
        />
      ) : null}
      {toast}
    </div>
  );
}
