import type { Metadata } from "next";
import { LoginForm } from "@/components/login-form";
import { Wordmark } from "@/components/ui";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { next } = await searchParams;
  const target = typeof next === "string" && next.startsWith("/app") ? next : "/app";
  return (
    <main id="content" className="grid min-h-dvh place-items-center px-5">
      <div className="w-full max-w-sm">
        <Wordmark />
        <h1 className="heading mt-8 text-4xl">Sign in to post.</h1>
        <p className="note mt-3">This Broadside is protected by a password set by whoever runs it.</p>
        <LoginForm next={target} />
      </div>
    </main>
  );
}
