import type { Metadata } from "next";
import { AccountsPanel } from "@/components/accounts-panel";
import { listAccounts } from "@/lib/accounts";
import { publicBase } from "@/lib/media";
import { pendingChoice } from "@/lib/oauth";
import { connectors, describe } from "@/lib/platforms";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Accounts" };

export default async function AccountsPage({ searchParams }: PageProps<"/app/accounts">) {
  const { connect, connected, error, choose } = await searchParams;
  // A sign-in that ended in a choice (which Page, which board) comes back here to make it.
  const choice = typeof choose === "string" ? pendingChoice(choose) : undefined;
  const notice =
    typeof connected === "string"
      ? { ok: true, text: `Connected ${connected}.` }
      : typeof error === "string"
        ? { ok: false, text: error }
        : typeof choose === "string" && !choice
          ? { ok: false, text: "That choice has run out or was already made. Sign in again to connect." }
          : undefined;
  return (
    <AccountsPanel
      accounts={listAccounts()}
      platforms={connectors.map(describe)}
      open={typeof connect === "string" ? connect : undefined}
      publicUrl={publicBase() || null}
      notice={notice}
      choice={choice}
    />
  );
}
