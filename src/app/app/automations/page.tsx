import type { Metadata } from "next";
import { AutomationsView } from "@/components/automations-view";
import { listAccounts } from "@/lib/accounts";
import { listFeeds } from "@/lib/feeds";
import { listGroups } from "@/lib/groups";
import { listOutgoingWebhooks } from "@/lib/outgoing";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Automations" };

/** Feeds and outgoing webhooks. Everything shown is read from the database; the page fetches no feed and calls no receiver. */
export default function AutomationsPage() {
  return (
    <AutomationsView
      feeds={listFeeds()}
      webhooks={listOutgoingWebhooks()}
      accounts={listAccounts().map((a) => ({ id: a.id, platform: a.platform, handle: a.handle }))}
      groups={listGroups().map((g) => ({ id: g.id, name: g.name, account_ids: g.account_ids }))}
    />
  );
}
