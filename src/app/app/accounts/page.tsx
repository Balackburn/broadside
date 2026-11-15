import type { Metadata } from "next";
import { AccountsPanel } from "@/components/accounts-panel";
import { listAccounts } from "@/lib/accounts";
import { publicBase } from "@/lib/media";
import { connectors, describe } from "@/lib/platforms";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Accounts" };

export default async function AccountsPage({ searchParams }: PageProps<"/app/accounts">) {
  const { connect, connected, error } = await searchParams;
  const notice = typeof connected === "string" ? { ok: true, text: `Connected ${connected}.` } : typeof error === "string" ? { ok: false, text: error } : undefined;
  return <AccountsPanel accounts={listAccounts()} platforms={connectors.map(describe)} open={typeof connect === "string" ? connect : undefined} hasPublicUrl={Boolean(publicBase())} notice={notice} />;
}
