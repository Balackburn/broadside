import type { Metadata } from "next";
import Link from "next/link";
import { JoinForm } from "@/components/join-form";
import { Wordmark } from "@/components/ui";
import { PASSWORD_MIN, peekInvite } from "@/lib/members";
import { ROLE_WORDS } from "@/lib/roles";

export const dynamic = "force-dynamic";
// A join link is for one person. It is kept out of search engines, and pages here send no Referer header, so the address goes nowhere else.
export const metadata: Metadata = { title: "Join", robots: { index: false, follow: false } };

/** Where a one-time join link lands. It shows who the link is for and asks only for a password of their own. */
export default async function JoinPage({ params }: PageProps<"/join/[token]">) {
  const { token } = await params;
  const invite = peekInvite(token);
  return (
    <main id="content" className="grid min-h-dvh place-items-center px-5">
      <div className="w-full max-w-sm">
        <Wordmark />
        {invite ? (
          <>
            <h1 className="heading mt-8 text-4xl">{invite.reset ? "Choose a new password." : "Join this Broadside."}</h1>
            <p className="note mt-3">
              {invite.reset ? `This link sets a new password for ${invite.name}.` : `You are joining as ${invite.name}, with the ${invite.role} role. ${ROLE_WORDS[invite.role]}`}
              {" The link works once."}
            </p>
            <JoinForm token={token} name={invite.name} min={PASSWORD_MIN} />
          </>
        ) : (
          <>
            <h1 className="heading mt-8 text-4xl">This link does not work.</h1>
            <p className="note mt-3">It has been used, has run out after seven days, or was never valid. Ask whoever invited you for a new one.</p>
            <Link className="btn mt-6" href="/login">
              Go to sign in
            </Link>
          </>
        )}
      </div>
    </main>
  );
}
