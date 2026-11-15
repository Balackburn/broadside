import { readFileSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connectAccount, InputError, listAccounts, removeAccount } from "./accounts";
import { getMedia, importMedia, listMedia, saveMedia } from "./media";
import { connector, connectors, describe, problems } from "./platforms";
import { cancelPost, createPost, deletePost, getPost, listPosts, publishNow, retryTarget, updatePost, type PostStatus } from "./posts";

export const VERSION = "0.1.0";

const targetShape = z.object({
  account_id: z.string().describe("An id returned by list_accounts."),
  content_override: z.string().optional().describe("Text for this account only, when the shared content does not fit its limit or voice."),
  options: z.record(z.string(), z.unknown()).optional().describe("Network-specific settings; list_platforms names the keys each network accepts."),
});

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

type Options = {
  /** Where the web app is reachable, for the links tools hand back. */
  baseUrl: string;
  /** True for the stdio server, which runs on the user's machine and may read local files. */
  local: boolean;
};

/**
 * The same tools back the hosted endpoint (/mcp) and the stdio server, so an
 * agent sees one Broadside wherever it connects from.
 */
export function buildServer({ baseUrl, local }: Options): McpServer {
  const server = new McpServer(
    { name: "broadside", version: VERSION },
    {
      instructions:
        "Broadside posts to many social networks at once. Call list_accounts first and use the ids it returns. " +
        "create_post refuses text or media a network would reject and says why; fix the post (content_override per account helps) rather than retrying unchanged. " +
        "After create_post, report each target's own status and url: one network can fail while the others publish. " +
        "Never ask the user for passwords or tokens in chat; connect_account returns a link where they enter them.",
    },
  );

  const reply = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: { result: data } as Record<string, unknown>,
  });

  const guard = <A>(handler: (args: A) => Promise<unknown> | unknown) => async (args: A) => {
    try {
      return reply(await handler(args));
    } catch (error) {
      const known = error instanceof InputError;
      const body = known ? { error: error.message, details: error.details } : { error: `Broadside hit an unexpected error: ${(error as Error).message}` };
      return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError: true };
    }
  };

  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const postLink = (id: string) => `${baseUrl}/app/posts?post=${id}`;
  const withLink = (post: NonNullable<ReturnType<typeof getPost>>) => ({ ...post, manage_url: postLink(post.id) });

  server.registerTool(
    "list_platforms",
    {
      title: "List networks",
      description: "Every network Broadside can post to, with its character limit, media rules, per-post options and what a user needs to connect it.",
      inputSchema: {},
      annotations: readOnly,
    },
    guard(() => connectors.map(describe)),
  );

  server.registerTool(
    "list_accounts",
    {
      title: "List connected accounts",
      description: "The accounts this Broadside can post to. Each has an id for create_post, its network, its handle and that network's limits.",
      inputSchema: {},
      annotations: readOnly,
    },
    guard(() =>
      listAccounts().map((account) => ({ ...account, limits: connector(account.platform)?.limits, options: connector(account.platform)?.options ?? [] })),
    ),
  );

  server.registerTool(
    "connect_account",
    {
      title: "Connect an account",
      description:
        "Returns the link where the user connects an account for a network. Credentials are entered in Broadside, never in chat. The sandbox network needs none and is created directly.",
      inputSchema: { platform: z.string().describe("A network id from list_platforms, for example bluesky."), name: z.string().optional().describe("A name for a sandbox account.") },
      annotations: { openWorldHint: false },
    },
    guard(async ({ platform, name }: { platform: string; name?: string }) => {
      const c = connector(platform);
      if (!c) throw new InputError(`Broadside has no network called "${platform}". Call list_platforms for the ids.`);
      if (platform === "sandbox") return { connected: await connectAccount("sandbox", { name: name ?? "Rehearsal" }) };
      return { connect_url: `${baseUrl}/app/accounts?connect=${platform}`, steps: c.setup, needs: c.fields.map((f) => f.label) };
    }),
  );

  server.registerTool(
    "disconnect_account",
    {
      title: "Disconnect an account",
      description: "Removes an account and deletes its stored credentials. Posts already published stay on the network.",
      inputSchema: { account_id: z.string() },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    guard(({ account_id }: { account_id: string }) => {
      if (!removeAccount(account_id)) throw new InputError(`No account with id ${account_id}.`);
      return { disconnected: account_id };
    }),
  );

  server.registerTool(
    "upload_media",
    {
      title: "Add an image or video",
      description:
        "Stores media for a post and returns its id for create_post. Give one of: url (Broadside downloads it), data_base64 with filename and content_type" +
        (local ? ", or path to a file on this machine." : ". This hosted server cannot read files on the user's computer."),
      inputSchema: {
        url: z.string().optional().describe("A public http(s) URL to download."),
        data_base64: z.string().optional().describe("The file's bytes, base64 encoded."),
        path: z.string().optional().describe("Absolute path to a local file. Only works on the local (stdio) server."),
        filename: z.string().optional(),
        content_type: z.string().optional().describe("For example image/png or video/mp4."),
        alt: z.string().optional().describe("Alt text describing the media, sent to networks that support it."),
      },
      annotations: { openWorldHint: true },
    },
    guard(async (args: { url?: string; data_base64?: string; path?: string; filename?: string; content_type?: string; alt?: string }) => {
      if (args.url) return importMedia(args.url, args.alt);
      if (args.path) {
        if (!local) throw new InputError("This Broadside server is remote and cannot read local files. Pass url or data_base64, or use the local stdio server.");
        const type = args.content_type ?? MIME[path.extname(args.path).toLowerCase()] ?? "";
        return saveMedia(new Uint8Array(readFileSync(args.path)), args.filename ?? path.basename(args.path), type, { alt: args.alt });
      }
      if (args.data_base64) {
        if (!args.filename || !args.content_type) throw new InputError("data_base64 needs filename and content_type alongside it.");
        return saveMedia(new Uint8Array(Buffer.from(args.data_base64, "base64")), args.filename, args.content_type, { alt: args.alt });
      }
      throw new InputError("Give upload_media a url, a path or data_base64.");
    }),
  );

  server.registerTool(
    "list_media",
    { title: "List media", description: "Recently added images and videos, newest first.", inputSchema: {}, annotations: readOnly },
    guard(() => listMedia()),
  );

  const postFields = {
    content: z.string().describe("The text of the post, shared by every target unless a target sets content_override."),
    targets: z.array(targetShape).min(1).describe("The accounts to post to."),
    media_ids: z.array(z.string()).optional().describe("Ids from upload_media, in display order."),
    publish_at: z.string().optional().describe("When to publish, ISO 8601 with an offset (2026-12-01T09:00:00+01:00). Omit to publish now."),
  };

  server.registerTool(
    "check_post",
    {
      title: "Check a post without sending it",
      description: "Reports, per account, whether this text and media fit that network and the measured length against its limit. Sends nothing.",
      inputSchema: { content: postFields.content, targets: postFields.targets, media_ids: postFields.media_ids },
      annotations: readOnly,
    },
    guard(({ content, targets, media_ids }: { content: string; targets: z.infer<typeof targetShape>[]; media_ids?: string[] }) => {
      const media = (media_ids ?? []).map((id) => {
        const found = getMedia(id);
        if (!found) throw new InputError(`No media with id ${id}.`);
        return { type: found.type, hasPublicUrl: Boolean(found.public_url) };
      });
      const accounts = listAccounts();
      return targets.map((target) => {
        const account = accounts.find((a) => a.id === target.account_id);
        const c = account && connector(account.platform);
        if (!account || !c) return { account_id: target.account_id, ok: false, problems: ["No connected account has this id."] };
        const found = problems(c, target.content_override ?? content, media);
        return { account_id: account.id, platform: account.platform, handle: account.handle, ok: found.length === 0, problems: found, max_chars: c.limits.maxChars };
      });
    }),
  );

  server.registerTool(
    "create_post",
    {
      title: "Publish or schedule a post",
      description:
        "Publishes one post to every target at once, or schedules it when publish_at is in the future. Returns the post with a status and url per target. " +
        "If any target would be rejected by its network the whole call is refused with the reasons and nothing is sent.",
      inputSchema: {
        ...postFields,
        draft: z.boolean().optional().describe("Save without publishing or scheduling."),
        idempotency_key: z.string().optional().describe("A stable key for this intended post. Repeating a call with the same key returns the first post instead of posting twice."),
      },
      annotations: { openWorldHint: true, idempotentHint: false },
    },
    guard(async (args: { content: string; targets: z.infer<typeof targetShape>[]; media_ids?: string[]; publish_at?: string; draft?: boolean; idempotency_key?: string }) =>
      withLink(await createPost({ ...args, origin: "mcp" })),
    ),
  );

  server.registerTool(
    "get_post",
    {
      title: "Read a post",
      description: "One post with the current status, error and public url of each target. Use it to confirm delivery.",
      inputSchema: { post_id: z.string() },
      annotations: readOnly,
    },
    guard(({ post_id }: { post_id: string }) => {
      const post = getPost(post_id);
      if (!post) throw new InputError(`No post with id ${post_id}.`);
      return withLink(post);
    }),
  );

  server.registerTool(
    "list_posts",
    {
      title: "List posts",
      description: "Posts, newest first. Filter by status (draft, scheduled, publishing, published, partial, failed, cancelled) or by a date range.",
      inputSchema: {
        status: z.enum(["draft", "scheduled", "publishing", "published", "partial", "failed", "cancelled"]).optional(),
        from: z.string().optional().describe("Earliest publish time, ISO 8601."),
        to: z.string().optional().describe("Latest publish time, ISO 8601."),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: readOnly,
    },
    guard((args: { status?: PostStatus; from?: string; to?: string; limit?: number }) => listPosts(args)),
  );

  server.registerTool(
    "update_post",
    {
      title: "Change a draft or scheduled post",
      description: "Edits the text, time, media or targets of a post that has not gone out. Published posts cannot be changed from here.",
      inputSchema: {
        post_id: z.string(),
        content: z.string().optional(),
        targets: z.array(targetShape).optional(),
        media_ids: z.array(z.string()).optional(),
        publish_at: z.string().nullable().optional(),
        draft: z.boolean().optional(),
      },
      annotations: { openWorldHint: true },
    },
    guard(async ({ post_id, ...patch }: { post_id: string; content?: string; targets?: z.infer<typeof targetShape>[]; media_ids?: string[]; publish_at?: string | null; draft?: boolean }) =>
      withLink(await updatePost(post_id, patch)),
    ),
  );

  server.registerTool(
    "publish_post",
    {
      title: "Publish a draft or scheduled post now",
      description: "Sends a draft or scheduled post immediately instead of waiting for its time.",
      inputSchema: { post_id: z.string() },
      annotations: { openWorldHint: true },
    },
    guard(async ({ post_id }: { post_id: string }) => withLink(await publishNow(post_id))),
  );

  server.registerTool(
    "cancel_post",
    {
      title: "Cancel a scheduled post",
      description: "Stops a draft or scheduled post from going out. It cannot take back what is already published.",
      inputSchema: { post_id: z.string() },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    guard(({ post_id }: { post_id: string }) => withLink(cancelPost(post_id))),
  );

  server.registerTool(
    "retry_target",
    {
      title: "Retry one failed network",
      description: "Sends a post again to a single target that failed, leaving the targets that succeeded alone.",
      inputSchema: { post_id: z.string(), target_id: z.string().describe("The id of a failed target from get_post.") },
      annotations: { openWorldHint: true },
    },
    guard(async ({ post_id, target_id }: { post_id: string; target_id: string }) => withLink(await retryTarget(post_id, target_id))),
  );

  server.registerTool(
    "delete_post",
    {
      title: "Delete a post record",
      description: "Removes a post from Broadside's history. It does not delete anything from the networks.",
      inputSchema: { post_id: z.string() },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    guard(({ post_id }: { post_id: string }) => {
      if (!deletePost(post_id)) throw new InputError(`No post with id ${post_id}.`);
      return { deleted: post_id };
    }),
  );

  return server;
}
