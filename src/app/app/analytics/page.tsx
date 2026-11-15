import type { Metadata } from "next";
import { AnalyticsView } from "@/components/analytics-view";
import { listAccounts } from "@/lib/accounts";
import { analytics, hasPublished, PERIODS, type Period } from "@/lib/analytics";
import { listTags } from "@/lib/tags";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Analytics" };

/** Everything on this screen is read from stored readings. The page asks no network; the scheduler and Refresh do that. */
export default async function AnalyticsPage({ searchParams }: PageProps<"/app/analytics">) {
  const { period, account, tag } = await searchParams;
  const days = PERIODS.find((d) => String(d) === period) ?? (30 as Period);
  const data = analytics({ days, account_id: typeof account === "string" ? account : null, tag: typeof tag === "string" ? tag : null });
  return (
    <AnalyticsView
      data={data}
      accounts={listAccounts().map((a) => ({ id: a.id, platform: a.platform, label: a.label, handle: a.handle }))}
      tags={listTags().map((t) => t.name)}
      everPublished={hasPublished()}
    />
  );
}
