import { Rail } from "@/components/rail";
import { passwordRequired } from "@/lib/session";

export default function AppLayout({ children }: LayoutProps<"/app">) {
  return (
    <div className="flex min-h-dvh">
      <Rail canSignOut={passwordRequired()} />
      <main id="content" className="min-w-0 flex-1 px-5 pt-8 pb-28 sm:px-8 lg:px-12 lg:pb-12">
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>
    </div>
  );
}
