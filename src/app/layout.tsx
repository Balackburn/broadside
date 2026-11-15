import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import "./globals.css";

const display = Instrument_Serif({ variable: "--font-serif", subsets: ["latin"], weight: "400", display: "swap" });
const text = Geist({ variable: "--font-geist", subsets: ["latin"], display: "swap" });
const code = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: { default: "Broadside: one post, every network", template: "%s · Broadside" },
  description: "A free, open-source app that publishes one post to every social network at once, from your browser or your AI agent over MCP.",
  metadataBase: new URL(process.env.BROADSIDE_PUBLIC_URL || "http://localhost:3000"),
  openGraph: { title: "Broadside: one post, every network", description: "Free, open-source, self-hosted. Post everywhere at once from your browser or your AI agent.", type: "website" },
};

export const viewport: Viewport = {
  themeColor: "#000000",
  colorScheme: "dark",
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
