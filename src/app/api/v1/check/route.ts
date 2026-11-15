import { InputError, listAccounts } from "@/lib/accounts";
import { body, route } from "@/lib/http";
import { getMedia } from "@/lib/media";
import { connector, measure, problems } from "@/lib/platforms";
import type { TargetInput } from "@/lib/posts";

/** A dry run: how this text and media fit each chosen account. Sends nothing. */
export const POST = route(async (request) => {
  const input = await body<{ content: string; targets: TargetInput[]; media_ids?: string[] }>(request);
  const media = (input.media_ids ?? []).map((id) => {
    const found = getMedia(id);
    if (!found) throw new InputError(`No media with id ${id}.`);
    return { type: found.type, hasPublicUrl: Boolean(found.public_url) };
  });
  const accounts = listAccounts();
  return (input.targets ?? []).map((target) => {
    const account = accounts.find((a) => a.id === target.account_id);
    const c = account && connector(account.platform);
    if (!account || !c) return { account_id: target.account_id, ok: false, problems: ["No connected account has this id."] };
    const text = target.content_override ?? input.content ?? "";
    const found = problems(c, text, media);
    return { account_id: account.id, platform: account.platform, ok: found.length === 0, problems: found, length: measure(text, c.limits.count), max_chars: c.limits.maxChars };
  });
});
