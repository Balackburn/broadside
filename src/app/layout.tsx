import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const display = Bricolage_Grotesque({ variable: "--font-bricolage", subsets: ["latin"], axes: ["wdth", "opsz"], display: "swap" });
const text = Geist({ variable: "--font-geist", subsets: ["latin"], display: "swap" });
const code = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: { default: "Broadside: one post, every network", template: "%s · Broadside" },
  description: "A free, open-source app that publishes one post to every social network at once, from your browser or your AI agent over MCP.",
  metadataBase: new URL(process.env.BROADSIDE_PUBLIC_URL || "http://localhost:3000"),
  openGraph: { title: "Broadside: one post, every network", description: "Free, open-source, self-hosted. Post everywhere at once from your browser or your AI agent.", type: "website" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f7f9" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1115" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${display.variable} ${text.variable} ${code.variable}`}>
      <body className="min-h-dvh">
        <a className="skip" href="#content">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
