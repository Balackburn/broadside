import { Rail } from "@/components/rail";
import { atLeast } from "@/lib/roles";
import { passwordRequired } from "@/lib/session";
import { viewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: LayoutProps<"/app">) {
  const me = await viewer();
  return (
    <div className="flex min-h-dvh">
      <Rail canSignOut={me.team || passwordRequired()} member={me.team && me.member ? { name: me.member.name, role: me.role } : undefined} canConnect={atLeast(me.role, "admin")} />
      <main id="content" className="min-w-0 flex-1 px-5 pt-8 pb-28 sm:px-8 lg:px-12 lg:pb-12">
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>
    </div>
  );
}
