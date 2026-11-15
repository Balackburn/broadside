import type { Metadata } from "next";
import { Composer, type ComposerInitial } from "@/components/composer";
import { listAccounts } from "@/lib/accounts";
import { connector, fits } from "@/lib/platforms";
import { getPost } from "@/lib/posts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Compose" };

/** With ?edit=<post id>, the composer opens that draft or scheduled post; anything already sent cannot be edited. */
export default async function ComposePage({ searchParams }: PageProps<"/app">) {
  const { edit } = await searchParams;
  const accounts = listAccounts().flatMap((account) => {
    const c = connector(account.platform);
    return c ? [{ id: account.id, platform: account.platform, handle: account.handle, ...fits(c) }] : [];
  });
  const post = typeof edit === "string" ? getPost(edit) : undefined;
  const initial: ComposerInitial | undefined =
    post && (post.status === "draft" || post.status === "scheduled")
      ? {
          id: post.id,
          content: post.content,
          publish_at: post.publish_at,
          draft: post.status === "draft",
          targets: post.targets.map((t) => ({ account_id: t.account_id, content_override: t.content_override })),
          media: post.media.map((m) => ({ id: m.id, type: m.type, url: m.url, public_url: m.public_url, filename: m.filename, alt: m.alt })),
          thread: post.thread,
          repeat: post.repeat && { every: post.repeat.every, until: post.repeat.until },
        }
      : undefined;
  return <Composer key={initial?.id ?? "new"} accounts={accounts} initial={initial} />;
}
