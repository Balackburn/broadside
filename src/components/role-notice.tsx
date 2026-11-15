import type { ReactNode } from "react";

/** What a screen shows a member in place of something their role cannot do: what it is, and who can do it or change their role. */
export function RoleNotice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h1 className="heading text-4xl">{title}</h1>
      <div className="panel mt-8 p-8 sm:p-10" role="status">
        <p className="note max-w-xl text-[15px] leading-snug">{children}</p>
      </div>
    </div>
  );
}
