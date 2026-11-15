import type { Metadata } from "next";
import { AutomationsView } from "@/components/automations-view";
import { listAccounts } from "@/lib/accounts";
import { listFeeds } from "@/lib/feeds";
import { listGroups } from "@/lib/groups";
import { listOutgoingWebhooks } from "@/lib/outgoing";
import { feedFor, webhookFor } from "@/lib/redact";
import { atLeast } from "@/lib/roles";
import { viewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Automations" };

/**
 * Feeds and outgoing webhooks. Everything shown is read from the database; the page fetches no feed and calls no receiver.
 * Admins set these up. Everyone else reads them, with the part of each address that could hold a token left out.
 */
export default async function AutomationsPage() {
  const me = await viewer();
  return (
    <AutomationsView
      feeds={listFeeds().map((feed) => feedFor(me.role, feed))}
      webhooks={listOutgoingWebhooks().map((webhook) => webhookFor(me.role, webhook))}
      accounts={listAccounts().map((a) => ({ id: a.id, platform: a.platform, handle: a.handle }))}
      groups={listGroups().map((g) => ({ id: g.id, name: g.name, account_ids: g.account_ids }))}
      canManage={atLeast(me.role, "admin")}
    />
  );
}
