import Link from "next/link";
import { Wordmark } from "@/components/ui";

export default function NotFound() {
  return (
    <main id="content" className="page flex min-h-dvh flex-col justify-between py-8">
      <Link href="/" aria-label="Broadside home">
        <Wordmark />
      </Link>
      <div>
        <h1 className="display text-[clamp(4rem,16vw,14rem)]">Not posted here.</h1>
        <p className="mt-6 max-w-md text-xl leading-snug text-ink-2">This page does not exist. The app and the front page do.</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link className="btn btn-signal btn-lg" href="/app">
            Open the app
          </Link>
          <Link className="btn btn-quiet btn-lg" href="/">
            Front page
          </Link>
        </div>
      </div>
      <p className="note">Error 404</p>
    </main>
  );
}
