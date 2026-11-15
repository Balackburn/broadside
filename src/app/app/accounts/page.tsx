import type { Metadata } from "next";
import { AccountsPanel } from "@/components/accounts-panel";
import { listAccounts } from "@/lib/accounts";
import { listGroups } from "@/lib/groups";
import { publicBase } from "@/lib/media";
import { pendingChoice } from "@/lib/oauth";
import { connectors, describe } from "@/lib/platforms";
import { atLeast } from "@/lib/roles";
import { listSignatures } from "@/lib/signatures";
import { viewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Accounts" };

export default async function AccountsPage({ searchParams }: PageProps<"/app/accounts">) {
  const { connect, connected, error, choose } = await searchParams;
  const me = await viewer();
  const canConnect = atLeast(me.role, "admin");
  // A sign-in that ended in a choice (which Page, which board) comes back here to make it. Only an admin connects, so only an admin is shown what is on offer.
  const choice = canConnect && typeof choose === "string" ? pendingChoice(choose) : undefined;
  const notice =
    typeof connected === "string"
      ? { ok: true, text: `Connected ${connected}.` }
      : typeof error === "string"
        ? { ok: false, text: error }
        : canConnect && typeof choose === "string" && !choice
          ? { ok: false, text: "That choice has run out or was already made. Sign in again to connect." }
          : undefined;
  return (
    <AccountsPanel
      accounts={listAccounts()}
      platforms={connectors.map(describe)}
      groups={listGroups()}
      signatures={listSignatures()}
      open={typeof connect === "string" ? connect : undefined}
      publicUrl={publicBase() || null}
      notice={notice}
      choice={choice}
      canConnect={canConnect}
      canWrite={atLeast(me.role, "editor")}
    />
  );
}
