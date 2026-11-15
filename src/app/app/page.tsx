import type { Metadata } from "next";
import { Composer } from "@/components/composer";
import { listAccounts } from "@/lib/accounts";
import { connector } from "@/lib/platforms";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Compose" };

export default function ComposePage() {
  const accounts = listAccounts().flatMap((account) => {
    const c = connector(account.platform);
    return c ? [{ id: account.id, platform: account.platform, name: c.name, handle: account.handle, limits: c.limits }] : [];
  });
  return <Composer accounts={accounts} />;
}
