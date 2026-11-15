import { createHmac } from "node:crypto";
import { blob, call, counted, json, PublishError, type Connector, type Credentials, type Reports } from "./types";

/* Telegram ---------------------------------------------------------------- */

const tg = (c: Credentials, method: string) =>
  `${(c.api_base || "https://api.telegram.org").replace(/\/+$/, "")}/bot${c.bot_token}/${method}`;

type TgResult<T> = { ok: boolean; result: T; description?: string };
type TgMessage = { message_id: number; chat: { username?: string } };

export const telegram: Connector = {
  id: "telegram",
  name: "Telegram",
  docsUrl: "https://core.telegram.org/bots#how-do-i-create-a-bot",
  setup: [
    "Message @BotFather, send /newbot and copy the token it gives you.",
    "Add the bot to your channel or group as an administrator that may post.",
    "Use the channel's @username, or its numeric id, as the chat.",
  ],
  fields: [
    { key: "bot_token", label: "Bot token", kind: "secret", placeholder: "123456:ABC-DEF" },
    { key: "chat_id", label: "Chat", kind: "text", placeholder: "@yourchannel" },
    { key: "api_base", label: "Bot API server", kind: "url", placeholder: "https://api.telegram.org", optional: true },
  ],
  options: [{ key: "silent", label: "Send without sound", kind: "boolean" }],
  limits: { maxChars: 4096, count: "graphemes", maxImages: 10, maxVideos: 1, requiresMedia: false },
  noMetrics: "Telegram's Bot API has no way to ask for a message's views or reactions.",

  async verify(c, ctx) {
    await call<TgResult<unknown>>(ctx, "Telegram", tg(c, "getMe"));
    const chat = await call<TgResult<{ title?: string; username?: string }>>(
      ctx,
      "Telegram",
      tg(c, "getChat"),
      json({ chat_id: c.chat_id }),
    );
    return { handle: chat.result.username ? `@${chat.result.username}` : (chat.result.title ?? c.chat_id) };
  },

  async publish(input, c, ctx) {
    const silent = Boolean(input.options.silent);
    const caption = input.text.length <= 1024 ? input.text : "";
    let sent: TgMessage | undefined;
    if (input.media.length === 1) {
      const item = input.media[0];
      const form = new FormData();
      form.set("chat_id", c.chat_id);
      form.set(item.type === "video" ? "video" : "photo", blob(await item.read(), item.contentType), item.filename);
      if (caption) form.set("caption", caption);
      if (silent) form.set("disable_notification", "true");
      const method = item.type === "video" ? "sendVideo" : "sendPhoto";
      sent = (await call<TgResult<TgMessage>>(ctx, "Telegram", tg(c, method), { method: "POST", body: form })).result;
    } else if (input.media.length > 1) {
      const form = new FormData();
      form.set("chat_id", c.chat_id);
      if (silent) form.set("disable_notification", "true");
      const group = [];
      for (const [i, item] of input.media.entries()) {
        form.set(`file${i}`, blob(await item.read(), item.contentType), item.filename);
        group.push({ type: item.type === "video" ? "video" : "photo", media: `attach://file${i}`, caption: i === 0 && caption ? caption : undefined });
      }
      form.set("media", JSON.stringify(group));
      const result = await call<TgResult<TgMessage[]>>(ctx, "Telegram", tg(c, "sendMediaGroup"), { method: "POST", body: form });
      sent = result.result[0];
    }
    if (!sent || !caption) {
      const message = await call<TgResult<TgMessage>>(
        ctx,
        "Telegram",
        tg(c, "sendMessage"),
        json({ chat_id: c.chat_id, text: input.text, disable_notification: silent }),
      );
      sent ??= message.result;
    }
    const username = sent.chat.username;
    return { id: String(sent.message_id), url: username ? `https://t.me/${username}/${sent.message_id}` : undefined };
  },

  async reply(input, c, ctx) {
    const { result: sent } = await call<TgResult<TgMessage>>(
      ctx,
      "Telegram",
      tg(c, "sendMessage"),
      json({ chat_id: c.chat_id, text: input.text, disable_notification: Boolean(input.options.silent), reply_parameters: { message_id: Number(input.parent.id) } }),
    );
    const username = sent.chat.username;
    return { id: String(sent.message_id), url: username ? `https://t.me/${username}/${sent.message_id}` : undefined };
  },
};

/* Discord ----------------------------------------------------------------- */

/** Reactions of every emoji, counted together. Discord has no view count. */
const discordReports: Reports = { likes: "Reactions" };

export const discord: Connector = {
  id: "discord",
  name: "Discord",
  docsUrl: "https://support.discord.com/hc/en-us/articles/228383668",
  setup: [
    "In your server open the channel's settings, Integrations, Webhooks.",
    "Create a webhook, copy its URL and paste it here.",
  ],
  fields: [{ key: "webhook_url", label: "Webhook URL", kind: "url", placeholder: "https://discord.com/api/webhooks/…" }],
  limits: { maxChars: 2000, count: "graphemes", maxImages: 10, maxVideos: 1, requiresMedia: false },
  noThread: "Discord cannot post a thread from a webhook.",

  async verify(c, ctx) {
    const hook = await call<{ name: string; guild_id?: string }>(ctx, "Discord", c.webhook_url);
    return { handle: hook.name, credentials: { guild_id: hook.guild_id ?? "" } };
  },

  async publish(input, c, ctx) {
    const url = `${c.webhook_url}${c.webhook_url.includes("?") ? "&" : "?"}wait=true`;
    let init: RequestInit = json({ content: input.text });
    if (input.media.length) {
      const form = new FormData();
      form.set("payload_json", JSON.stringify({ content: input.text }));
      for (const [i, item] of input.media.entries()) {
        form.set(`files[${i}]`, blob(await item.read(), item.contentType), item.filename);
      }
      init = { method: "POST", body: form };
    }
    const message = await call<{ id: string; channel_id: string }>(ctx, "Discord", url, init);
    return {
      id: message.id,
      url: c.guild_id ? `https://discord.com/channels/${c.guild_id}/${message.channel_id}/${message.id}` : undefined,
    };
  },

  reports: discordReports,
  async metrics(input, c, ctx) {
    // A webhook may read back a message it sent, at its own address.
    const url = new URL(c.webhook_url);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/messages/${encodeURIComponent(input.id)}`;
    url.searchParams.delete("wait");
    const message = await call<{ id?: string; reactions?: { count?: number }[] }>(ctx, "Discord", url.toString());
    if (!message.id) throw new PublishError("Discord returned no message for this id.");
    // Discord leaves `reactions` out of a message nobody has reacted to.
    return { metrics: counted(discordReports, { likes: (message.reactions ?? []).reduce((sum, reaction) => sum + (reaction.count ?? 0), 0) }) };
  },
};

/* Slack ------------------------------------------------------------------- */

export const slack: Connector = {
  id: "slack",
  name: "Slack",
  docsUrl: "https://api.slack.com/messaging/webhooks",
  setup: [
    "Create a Slack app for your workspace and turn on Incoming Webhooks.",
    "Add a webhook for the channel you want and paste its URL here.",
  ],
  fields: [
    { key: "webhook_url", label: "Webhook URL", kind: "url", placeholder: "https://hooks.slack.com/services/…" },
    { key: "channel", label: "Channel name", kind: "text", placeholder: "#announcements", optional: true },
  ],
  limits: { maxChars: 3000, count: "graphemes", maxImages: 4, maxVideos: 0, requiresMedia: false, pullsMedia: true },
  noThread: "Slack cannot post a thread from an incoming webhook.",
  noMetrics: "A Slack incoming webhook can post a message and cannot read anything back.",

  async verify(c) {
    if (!/^https:\/\/hooks\.slack\.com\//.test(c.webhook_url) && !process.env.BROADSIDE_ALLOW_ANY_WEBHOOK) {
      throw new PublishError("That does not look like a Slack incoming webhook URL.");
    }
    return { handle: c.channel || "Slack channel" };
  },

  async publish(input, c, ctx) {
    const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: input.text } }];
    for (const item of input.media) {
      blocks.push({ type: "image", image_url: item.publicUrl, alt_text: item.alt || item.filename });
    }
    await call(ctx, "Slack", c.webhook_url, json(input.media.length ? { text: input.text, blocks } : { text: input.text }));
    return { id: `slack-${Date.now()}` };
  },
};

/* Generic webhook --------------------------------------------------------- */

export const webhook: Connector = {
  id: "webhook",
  name: "Webhook",
  docsUrl: "",
  setup: [
    "Point this at any URL that accepts a JSON POST: Zapier, n8n, Make, or your own server.",
    "Each post arrives as { text, media, options }. Reply with { id, url } to have them shown here.",
    "This is a destination: it receives your posts. To be told when a post is published or fails, add an outgoing webhook under Automations.",
  ],
  fields: [
    { key: "url", label: "URL", kind: "url", placeholder: "https://example.com/hooks/broadside" },
    { key: "name", label: "Name", kind: "text", placeholder: "My automation" },
    { key: "secret", label: "Signing secret", kind: "secret", optional: true, help: "Sent as an HMAC-SHA256 of the body in x-broadside-signature." },
  ],
  limits: { maxChars: 100_000, count: "graphemes", maxImages: 20, maxVideos: 5, requiresMedia: false, pullsMedia: true },
  noMetrics: "A webhook receives the post and reports nothing back about it.",

  async verify(c) {
    new URL(c.url);
    return { handle: c.name || new URL(c.url).host };
  },

  async publish(input, c, ctx) {
    const body = JSON.stringify({
      text: input.text,
      media: input.media.map((m) => ({ type: m.type, url: m.publicUrl, alt: m.alt, content_type: m.contentType })),
      options: input.options,
    });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (c.secret) headers["x-broadside-signature"] = createHmac("sha256", c.secret).update(body).digest("hex");
    const reply = await call<{ id?: string; url?: string } | string>(ctx, "Webhook", c.url, { method: "POST", headers, body });
    const data = typeof reply === "string" ? {} : reply;
    return { id: data.id ?? `webhook-${Date.now()}`, url: data.url };
  },
};

/* Sandbox ----------------------------------------------------------------- */

/** A destination that publishes nowhere. It lets you rehearse the whole flow before connecting a real network. */
export const sandbox: Connector = {
  id: "sandbox",
  name: "Sandbox",
  docsUrl: "",
  setup: ["Nothing to set up. Posts sent here are recorded in Broadside and go nowhere else."],
  fields: [{ key: "name", label: "Name", kind: "text", placeholder: "Rehearsal" }],
  limits: { maxChars: 5000, count: "graphemes", maxImages: 10, maxVideos: 2, requiresMedia: false },
  noMetrics: "The sandbox publishes nowhere, so there is nothing to count.",
  async verify(c) {
    return { handle: c.name || "Rehearsal" };
  },
  async publish(input) {
    if (/\[fail\]/i.test(input.text)) throw new PublishError("The sandbox was asked to fail by a [fail] marker in the text.");
    return { id: `sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
  },
  async reply(input) {
    if (/\[fail\]/i.test(input.text)) throw new PublishError("The sandbox was asked to fail by a [fail] marker in the text.");
    return { id: `sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
  },
};
