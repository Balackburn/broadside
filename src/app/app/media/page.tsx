import type { Metadata } from "next";
import { MediaLibrary } from "@/components/media-library";
import { listLibrary } from "@/lib/media";
import { atLeast } from "@/lib/roles";
import { viewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Media" };

/** The media library: everything uploaded or imported, newest first, with the posts that use each file. */
export default async function MediaPage() {
  const me = await viewer();
  return <MediaLibrary items={listLibrary(1000)} canWrite={atLeast(me.role, "editor")} />;
}
