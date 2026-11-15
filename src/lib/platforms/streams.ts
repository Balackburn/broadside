import { tokenFields, withSession } from "./oauth2";
import { call, json, PublishError, type Connector, type Context, type Credentials, type OAuthSpec, type PublishResult } from "./types";

/**
 * The chat of a live channel, on Twitch and on Kick. A post is one chat
 * message, sent as the person who signed in; a thread is sent as replies to
 * it. Neither takes media, and neither keeps a count for a message.
 */

const noRefresh = (network: string) => new PublishError(`${network} returned no refresh token, so the account could not stay connected. Sign in again.`);

/* Twitch ------------------------------------------------------------------ */

/**
 * Read on 2026-11-15:
 *   https://dev.twitch.tv/docs/api/reference/chat  (Send Chat Message: POST /helix/chat/messages)
 *   https://dev.twitch.tv/docs/api/reference/users  (Get Users: the user in the token when no id or login is given)
 *   https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/  (authorization code grant flow)
 *   https://dev.twitch.tv/docs/authentication/refresh-tokens/
 *   https://dev.twitch.tv/docs/authentication/register-app/
 *
 * Left open by those pages:
 * - "The message is limited to a maximum of 500 characters" does not say how
 *   a character is counted. Broadside counts what a reader sees as one. A
 *   message Twitch finds too large is answered 422, in its own words.
 * - Nothing is said about a line break inside a message. The text is sent as
 *   it was written.
 * - Twitch advises renewing a token when a call is answered 401, since a
 *   token can stop working before its time. Broadside renews when the time
 *   Twitch gave is nearly up, as it does for every network; a token ended
 *   early is refused once, in Twitch's words.
 */
const HELIX = "https://api.twitch.tv/helix";

const twitchOAuth: OAuthSpec = {
  authorizeUrl: "https://id.twitch.tv/oauth2/authorize",
  tokenUrl: "https://id.twitch.tv/oauth2/token",
  // The one scope a user's token needs to send a chat message as that user.
  scopes: ["user:write:chat"],
  client: { id: "client_id", secret: "client_secret" },
  pkce: "none",
  clientAuth: "body",
  // Twitch's own example registers http://localhost:3000, so that is the name used for this machine.
  loopback: "localhost",
  async exchange(tokens, app) {
    if (!tokens.refresh_token) throw noRefresh("Twitch");
    return { ...app, ...tokenFields(tokens) };
  },
  paste: {
    required: ["client_id", "client_secret", "refresh_token"],
    optional: ["channel"],
    help: "Authorise your application for the scope user:write:chat with the authorization code flow and keep the refresh token.",
  },
};

type TwitchUser = { id: string; login: string; display_name?: string; profile_image_url?: string };
type TwitchSent = { data?: { message_id?: string; is_sent?: boolean; drop_reason?: { code?: string; message?: string } | null }[] };

const twitchHeaders = (live: Credentials) => ({ authorization: `Bearer ${live.access_token}`, "client-id": live.client_id });

async function twitchSend(c: Credentials, ctx: Context, message: string, replyTo?: string): Promise<PublishResult> {
  if (!c.sender_id || !c.broadcaster_id) throw new PublishError("This Twitch account was connected without its channel. Reconnect it.");
  return withSession<PublishResult>("Twitch", twitchOAuth, c, ctx, async (live) => {
    const answer = await call<TwitchSent>(ctx, "Twitch", `${HELIX}/chat/messages`, json({ broadcaster_id: c.broadcaster_id, sender_id: c.sender_id, message, reply_parent_message_id: replyTo }, twitchHeaders(live)));
    const sent = answer.data?.[0];
    // Twitch answers 200 for a message its chat rules dropped, and says why.
    if (!sent?.is_sent || !sent.message_id) throw new PublishError(`Twitch did not send the message: ${sent?.drop_reason?.message || sent?.drop_reason?.code || "it gave no reason"}`);
    return { id: sent.message_id };
  });
}

export const twitch: Connector = {
  id: "twitch",
  name: "Twitch",
  docsUrl: "https://dev.twitch.tv/docs/api/reference/chat",
  setup: [
    "Turn on two-factor authentication for your Twitch account, then open dev.twitch.tv/console, Applications, Register Your Application.",
    "Under OAuth Redirect URLs add the redirect address shown below. Open the application with Manage, copy its Client ID and press New Secret for a client secret.",
    "Paste both here, then continue to Twitch and approve. Each post is sent as a chat message from your account.",
    "Leave the channel empty to write in your own chat, or name another channel you are allowed to chat in.",
  ],
  fields: [
    { key: "client_id", label: "Client ID", kind: "text", help: "From your application's Manage page in the Twitch developer console." },
    { key: "client_secret", label: "Client secret", kind: "secret", help: "Press New Secret on the same page and copy it." },
    { key: "channel", label: "Channel", kind: "text", optional: true, placeholder: "yourchannel", help: "The channel whose chat to write in, by its login name. Leave empty for your own." },
    { key: "refresh_token", label: "Refresh token", kind: "secret", hidden: true },
  ],
  oauth: twitchOAuth,
  limits: { maxChars: 500, count: "graphemes", maxImages: 0, maxVideos: 0, requiresMedia: false },
  noMetrics: "Twitch keeps no count for a chat message.",

  async verify(c, ctx) {
    return withSession("Twitch", twitchOAuth, c, ctx, async (live) => {
      const users = (login?: string) => call<{ data?: TwitchUser[] }>(ctx, "Twitch", `${HELIX}/users${login ? `?login=${encodeURIComponent(login)}` : ""}`, { headers: twitchHeaders(live) });
      const self = (await users()).data?.[0];
      if (!self) throw new PublishError("Twitch returned no user for this sign-in.");
      const wanted = (c.channel ?? "").trim().replace(/^#/, "").toLowerCase();
      const channel = wanted && wanted !== self.login ? (await users(wanted)).data?.[0] : self;
      if (!channel) throw new PublishError(`Twitch has no channel called "${wanted}".`);
      return {
        handle: channel.id === self.id ? self.display_name || self.login : `${self.display_name || self.login} in ${channel.login}'s chat`,
        avatarUrl: self.profile_image_url,
        credentials: { sender_id: self.id, broadcaster_id: channel.id, channel: channel.login },
      };
    });
  },

  publish: (input, c, ctx) => twitchSend(c, ctx, input.text),
  // A later part answers the part before it, which Twitch shows as a reply in chat.
  reply: (input, c, ctx) => twitchSend(c, ctx, input.text, input.parent.id),
};

/* Kick -------------------------------------------------------------------- */

/**
 * Read on 2026-11-15:
 *   https://docs.kick.com/getting-started/kick-apps-setup  (an app is made under Account Settings, Developer; 2FA first)
 *   https://docs.kick.com/getting-started/generating-tokens-oauth2-flow  (OAuth 2.1 with PKCE on id.kick.com)
 *   https://docs.kick.com/getting-started/scopes  (user:read, chat:write)
 *   https://docs.kick.com/apis/users  (GET /public/v1/users: the signed-in user when no id is given)
 *   https://docs.kick.com/apis/chat  (POST /public/v1/chat)
 *
 * Left open by those pages:
 * - The chat and users pages name a user access token and do not spell out
 *   the header. The OAuth page sends "Authorization: Bearer <access token>"
 *   to its own endpoint, and the same is sent here.
 * - The token answers are shown with empty values, so how long a token lasts
 *   is whatever expires_in says when one is issued.
 * - A message sent as a user needs the id of the channel's owner. Kick
 *   documents no way to find that id from a channel's name without a further
 *   scope, so another channel is named by its number.
 * - Nothing is said about a line break inside a message. The text is sent as
 *   it was written.
 */
const KICK = "https://api.kick.com/public/v1";
const KICK_BYTES = 2048;

const kickOAuth: OAuthSpec = {
  authorizeUrl: "https://id.kick.com/oauth/authorize",
  tokenUrl: "https://id.kick.com/oauth/token",
  // user:read names the account that signed in; chat:write sends the message.
  scopes: ["user:read", "chat:write"],
  client: { id: "client_id", secret: "client_secret" },
  pkce: "S256",
  clientAuth: "body",
  // Kick's sign-in page rewrites a redirect address on 127.0.0.1, so the name it leaves alone is used.
  loopback: "localhost",
  async exchange(tokens, app) {
    if (!tokens.refresh_token) throw noRefresh("Kick");
    return { ...app, ...tokenFields(tokens) };
  },
  paste: {
    required: ["client_id", "client_secret", "refresh_token"],
    optional: ["broadcaster_user_id"],
    help: "Authorise your app for the scopes user:read and chat:write and keep the refresh token.",
  },
};

type KickSent = { data?: { is_sent?: boolean; message_id?: string }; message?: string };

async function kickSend(c: Credentials, ctx: Context, content: string, replyTo?: string): Promise<PublishResult> {
  const channel = Number(c.broadcaster_user_id || c.user_id);
  if (!Number.isInteger(channel) || channel <= 0) throw new PublishError("This Kick account was connected without its channel. Reconnect it.");
  // Kick sets two limits: 500 characters, which is checked before a post is accepted, and the size of the text as it is sent.
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > KICK_BYTES) throw new PublishError(`Kick allows 2,048 bytes in a message; this is ${bytes}.`);
  return withSession<PublishResult>("Kick", kickOAuth, c, ctx, async (live) => {
    const answer = await call<KickSent>(ctx, "Kick", `${KICK}/chat`, json({ broadcaster_user_id: channel, content, type: "user", reply_to_message_id: replyTo }, { authorization: `Bearer ${live.access_token}` }));
    if (!answer.data?.is_sent || !answer.data.message_id) throw new PublishError(`Kick did not send the message: ${answer.message || "it gave no reason"}`);
    return { id: answer.data.message_id };
  });
}

export const kick: Connector = {
  id: "kick",
  name: "Kick",
  docsUrl: "https://docs.kick.com/apis/chat",
  setup: [
    "Turn on two-factor authentication for your Kick account, then open Account Settings, Developer and create an app.",
    "Give the app the redirect address shown below.",
    "Paste its Client ID and Client Secret here, then continue to Kick and approve. Each post is sent as a chat message from your account, in your own channel's chat.",
  ],
  fields: [
    { key: "client_id", label: "Client ID", kind: "text", help: "From your app under Account Settings, Developer on Kick." },
    { key: "client_secret", label: "Client Secret", kind: "secret", help: "Shown with the Client ID for the same app." },
    { key: "broadcaster_user_id", label: "Channel's user id", kind: "text", optional: true, placeholder: "123456", help: "The number of the channel owner whose chat to write in. Leave empty for your own channel." },
    { key: "refresh_token", label: "Refresh token", kind: "secret", hidden: true },
  ],
  oauth: kickOAuth,
  limits: { maxChars: 500, count: "graphemes", maxImages: 0, maxVideos: 0, requiresMedia: false },
  noMetrics: "Kick keeps no count for a chat message.",

  async verify(c, ctx) {
    const other = (c.broadcaster_user_id ?? "").trim();
    if (other && !/^\d+$/.test(other)) throw new PublishError("The channel's user id is a number. Leave it empty to write in your own channel's chat.");
    return withSession("Kick", kickOAuth, c, ctx, async (live) => {
      const found = await call<{ data?: { user_id?: number; name?: string; profile_picture?: string }[] }>(ctx, "Kick", `${KICK}/users`, { headers: { authorization: `Bearer ${live.access_token}` } });
      const self = found.data?.[0];
      if (!self?.user_id) throw new PublishError("Kick returned no user for this sign-in.");
      const own = !other || other === String(self.user_id);
      return { handle: own ? (self.name ?? "Kick account") : `${self.name} in the chat of channel ${other}`, avatarUrl: self.profile_picture || undefined, credentials: { user_id: String(self.user_id) } };
    });
  },

  publish: (input, c, ctx) => kickSend(c, ctx, input.text),
  // A later part answers the part before it.
  reply: (input, c, ctx) => kickSend(c, ctx, input.text, input.parent.id),
};
