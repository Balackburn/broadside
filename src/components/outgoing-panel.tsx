"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Delivery, EventName, OutgoingWebhook } from "@/lib/outgoing";
import { api, CopyButton, Dialog, Icon, Time } from "./ui";

/** Every event a webhook can ask for, in the words a person would use. The Record type keeps this list whole when an event is added. */
const EVENT_LABELS: Record<EventName, string> = {
  "post.published": "A post is published",
  "post.partial": "A post is partly published",
  "post.failed": "A post fails",
  "post.scheduled": "A post is scheduled",
  "target.failed": "One network fails",
};
/** The same events, short, for the row of tags on a card. */
const EVENT_TAGS: Record<EventName, string> = {
  "post.published": "Post published",
  "post.partial": "Post partly published",
  "post.failed": "Post failed",
  "post.scheduled": "Post scheduled",
  "target.failed": "One network failed",
};
const ALL_EVENTS = Object.keys(EVENT_LABELS) as EventName[];

const DELIVERY_WORDS: Record<Delivery["status"], string> = { pending: "Waiting", delivering: "Sending", retrying: "Will retry", delivered: "Delivered", failed: "Failed" };
/** The colours the status class already has: green for done, red for failed, grey for anything still on its way. */
const DELIVERY_TONE: Record<Delivery["status"], string> = { pending: "draft", delivering: "draft", retrying: "partial", delivered: "published", failed: "failed" };

/** How many deliveries a card shows before "Show all". */
const SHOWN = 4;

/**
 * Outgoing webhooks: addresses Broadside calls when something happens to a
 * post. Not to be confused with the Webhook network under Accounts, which is
 * a place posts are sent to.
 */
export function OutgoingPanel({ webhooks, show }: { webhooks: OutgoingWebhook[]; show: (message: string) => void }) {
  const router = useRouter();
  const [editing, setEditing] = useState<OutgoingWebhook | "new" | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<EventName[]>(ALL_EVENTS);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  // The signing secret of the webhook just made. It is in memory here until the page is left, and nowhere it can be read again.
  const [fresh, setFresh] = useState<{ id: string; name: string; secret: string } | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);

  const start = (webhook: OutgoingWebhook | "new") => {
    setName(webhook === "new" ? "" : webhook.name);
    setUrl(webhook === "new" ? "" : webhook.url);
    setEvents(webhook === "new" ? ALL_EVENTS : webhook.events);
    setError(null);
    setEditing(webhook);
  };

  const toggle = (event: EventName) => setEvents((now) => (now.includes(event) ? now.filter((e) => e !== event) : ALL_EVENTS.filter((e) => e === event || now.includes(e))));

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!editing) return;
    setBusy("save");
    setError(null);
    try {
      const body = JSON.stringify({ name, url, events });
      if (editing === "new") {
        const made = await api<OutgoingWebhook & { secret: string }>("/outgoing-webhooks", { method: "POST", body });
        setFresh({ id: made.id, name: made.name, secret: made.secret });
      } else {
        await api(`/outgoing-webhooks/${editing.id}`, { method: "PATCH", body });
        show(`Saved ${name.trim()}.`);
      }
      setEditing(null);
      router.refresh();
    } catch (cause) {
      setError((cause as Error).message);
      setShake((n) => n + 1);
    } finally {
      setBusy(null);
    }
  }

  async function act(webhook: OutgoingWebhook, key: string, run: () => Promise<string>) {
    setBusy(`${key}:${webhook.id}`);
    try {
      show(await run());
      router.refresh();
    } catch (cause) {
      show((cause as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const sendTest = (webhook: OutgoingWebhook) =>
    act(webhook, "test", async () => {
      const sent = await api<Delivery>(`/outgoing-webhooks/${webhook.id}/test`, { method: "POST" });
      return sent.status === "delivered" ? `Test delivered. The receiver answered ${sent.response_code}.` : `The test failed. ${sent.error ?? ""}`.trim();
    });

  const remove = (webhook: OutgoingWebhook) => {
    if (!window.confirm(`Delete the outgoing webhook "${webhook.name}"? Broadside stops calling it, and its signing secret is gone for good.`)) return;
    void act(webhook, "delete", async () => {
      await api(`/outgoing-webhooks/${webhook.id}`, { method: "DELETE" });
      if (fresh?.id === webhook.id) setFresh(null);
      return `Deleted ${webhook.name}.`;
    });
  };

  return (
    <section className="mt-14" aria-label="Outgoing webhooks">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="title text-2xl">Outgoing webhooks</h2>
        {webhooks.length ? (
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => start("new")}>
            <Icon name="plus" size={16} /> Add outgoing webhook
          </button>
        ) : null}
      </div>
      <p className="note mt-2 max-w-2xl">
        Broadside calls these addresses with a signed request when a post is published, fails or is scheduled. To send your posts to an address as one more destination, connect the Webhook network under Accounts instead.
      </p>

      {fresh ? (
        <div className="sheet mt-4" style={{ boxShadow: "inset 0 0 0 2px var(--signal)" }}>
          <p className="font-medium">{`Copy the signing secret for ${fresh.name} now. It is shown once.`}</p>
          <div className="mt-3 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md bg-paper-2 px-3 py-2 font-mono text-sm">{fresh.secret}</code>
            <CopyButton text={fresh.secret} />
          </div>
          <p className="note mt-3">
            {"Each request carries "}
            <code className="font-mono text-[13px]">X-Broadside-Timestamp</code>, <code className="font-mono text-[13px]">X-Broadside-Delivery</code> and <code className="font-mono text-[13px]">X-Broadside-Event-Signature</code>
            {". The signature is v1= followed by the HMAC-SHA256, in hex, of the timestamp, a dot, the delivery id, a dot and the body, keyed with this secret. Refuse a request whose timestamp is more than five minutes old."}
          </p>
          <button type="button" className="btn btn-quiet btn-sm mt-3" onClick={() => setFresh(null)}>
            I have copied it
          </button>
        </div>
      ) : null}

      {webhooks.length === 0 ? (
        <div className="panel mt-4 p-6">
          <p className="title text-lg">No outgoing webhooks yet.</p>
          <p className="note mt-2 max-w-xl">Add an address on your own server, or in Zapier, n8n or Make, and Broadside tells it what happened to each post, with the post attached.</p>
          <button type="button" className="btn btn-sm mt-4" onClick={() => start("new")}>
            <Icon name="plus" size={16} /> Add outgoing webhook
          </button>
        </div>
      ) : (
        <ul className="mt-4 space-y-2">
          {webhooks.map((webhook) => {
            const all = expanded.includes(webhook.id);
            const log = all ? webhook.deliveries : webhook.deliveries.slice(0, SHOWN);
            return (
              <li key={webhook.id} className="panel p-4">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="truncate font-medium">{webhook.name}</p>
                    <p className="note truncate font-mono text-[13px]">{webhook.url}</p>
                  </div>
                  <span className="status" data-status={webhook.status === "paused" ? (webhook.paused_reason ? "failed" : "draft") : "published"}>
                    {webhook.status === "paused" && webhook.paused_reason ? <Icon name="alert" size={16} /> : null}
                    {webhook.status === "paused" ? "Paused" : "Active"}
                  </span>
                </div>
                {webhook.paused_reason ? (
                  <p className="mt-2 text-sm text-bad" role="status">
                    {`${webhook.paused_reason} Send a test, then resume it.`}
                  </p>
                ) : null}
                <p className="mt-3 flex flex-wrap items-center gap-1.5">
                  <span className="note mr-1">Called when</span>
                  {webhook.events.map((event) => (
                    <span key={event} className="tag">
                      {EVENT_TAGS[event]}
                    </span>
                  ))}
                </p>

                <div className="mt-3 rounded-md bg-paper-2 p-3">
                  {webhook.deliveries.length === 0 ? (
                    <p className="note">Nothing sent yet. Send a test to see how your receiver answers.</p>
                  ) : (
                    <>
                      <ul className="space-y-2" aria-label={`Deliveries to ${webhook.name}`}>
                        {log.map((delivery) => (
                          <li key={delivery.id} className="text-sm">
                            <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                              <code className="font-mono text-[13px]">{delivery.event}</code>
                              <span className="status" data-status={DELIVERY_TONE[delivery.status]}>
                                {DELIVERY_WORDS[delivery.status]}
                              </span>
                              <span className="note num">
                                <Time iso={delivery.attempted_at ?? delivery.created_at} />
                              </span>
                              <span className="note num">{delivery.response_code ? `HTTP ${delivery.response_code}` : delivery.attempts ? "No answer" : "Not sent yet"}</span>
                              {delivery.attempts ? <span className="note num">{`Attempt ${delivery.attempts}`}</span> : null}
                            </span>
                            {delivery.error ? <span className="mt-0.5 block text-bad">{delivery.error}</span> : null}
                            {delivery.status === "retrying" && delivery.next_attempt_at ? (
                              <span className="note mt-0.5 block">
                                {"Next try "}
                                <span className="num">
                                  <Time iso={delivery.next_attempt_at} />
                                </span>
                              </span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                      {webhook.deliveries.length > SHOWN ? (
                        <button type="button" className="btn btn-bare btn-sm -ml-3 mt-1" aria-expanded={all} onClick={() => setExpanded((now) => (all ? now.filter((id) => id !== webhook.id) : [...now, webhook.id]))}>
                          {all ? "Show fewer" : `Show all ${webhook.deliveries.length}`}
                        </button>
                      ) : null}
                    </>
                  )}
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" className="btn btn-quiet btn-sm" disabled={busy !== null} onClick={() => sendTest(webhook)}>
                    {busy === `test:${webhook.id}` ? <span className="spinner" /> : null} Send a test
                  </button>
                  <button type="button" className="btn btn-bare btn-sm" onClick={() => start(webhook)} aria-label={`Edit the outgoing webhook ${webhook.name}`}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn btn-bare btn-sm"
                    disabled={busy !== null}
                    onClick={() =>
                      act(webhook, "pause", async () => {
                        await api(`/outgoing-webhooks/${webhook.id}`, { method: "PATCH", body: JSON.stringify({ paused: webhook.status === "active" }) });
                        return webhook.status === "active" ? "Paused. Nothing is sent until you resume it." : "Resumed.";
                      })
                    }
                  >
                    {webhook.status === "active" ? "Pause" : "Resume"}
                  </button>
                  <button type="button" className="btn btn-bare btn-sm" disabled={busy !== null} onClick={() => remove(webhook)} aria-label={`Delete the outgoing webhook ${webhook.name}`}>
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing === "new" ? "Add an outgoing webhook" : "Edit outgoing webhook"}>
        <form onSubmit={save} key={shake} className={shake && error ? "is-shaking" : ""}>
          <label className="label" htmlFor="outgoing-name">
            Name
          </label>
          <input id="outgoing-name" className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Team chat alerts" maxLength={60} autoComplete="off" data-autofocus required />
          <label className="label mt-5" htmlFor="outgoing-url">
            Address to call
          </label>
          <input id="outgoing-url" className="field" type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/broadside" autoComplete="off" required />
          <p className="label mt-5" id="outgoing-events">
            Call it when
          </p>
          <div className="flex flex-wrap gap-2" role="group" aria-labelledby="outgoing-events">
            {ALL_EVENTS.map((event) => (
              <button key={event} type="button" className="chip pl-3" aria-pressed={events.includes(event)} onClick={() => toggle(event)}>
                {EVENT_LABELS[event]}
              </button>
            ))}
          </div>
          {editing === "new" ? <p className="note mt-4">Broadside makes a signing secret for this webhook and shows it once, right after you add it.</p> : null}
          {error ? (
            <p className="mt-4 text-sm font-medium text-bad" role="alert">
              {error}
            </p>
          ) : null}
          <div className="mt-6 flex justify-end gap-2">
            <button type="button" className="btn btn-quiet" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-signal" disabled={busy === "save" || !name.trim() || !url.trim() || events.length === 0}>
              {busy === "save" ? <span className="spinner" /> : null}
              {busy === "save" ? "Saving" : editing === "new" ? "Add webhook" : "Save webhook"}
            </button>
          </div>
        </form>
      </Dialog>
    </section>
  );
}
