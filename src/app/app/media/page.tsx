import type { Metadata } from "next";
import { MediaLibrary } from "@/components/media-library";
import { listLibrary } from "@/lib/media";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Media" };

/** The media library: everything uploaded or imported, newest first, with the posts that use each file. */
export default function MediaPage() {
  return <MediaLibrary items={listLibrary(1000)} />;
}
