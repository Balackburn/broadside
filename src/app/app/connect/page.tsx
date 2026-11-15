import type { Metadata } from "next";
import { headers } from "next/headers";
import { KeysPanel } from "@/components/keys-panel";
import { listKeys } from "@/lib/keys";
import { publicBase } from "@/lib/media";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Connect" };

export default async function ConnectPage() {
  const h = await headers();
  const base = publicBase() ?? `http://${h.get("host") ?? "localhost:3000"}`;
  return <KeysPanel keys={listKeys()} base={base} cwd={process.cwd()} />;
}
