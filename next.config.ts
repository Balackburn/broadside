import type { NextConfig } from "next";

const dev = process.env.NODE_ENV !== "production";

/**
 * Sent with every response. Broadside loads nothing from other origins, so
 * the policy is closed: no framing, no plugins, scripts and styles from here
 * only. Next's own inline bootstrap needs 'unsafe-inline'; the dev server
 * also needs eval and a websocket for hot reload.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  `connect-src 'self'${dev ? " ws:" : ""}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

// A second build directory lets `npm run verify` build and serve without touching a server already running from .next.
const nextConfig: NextConfig = {
  distDir: process.env.BROADSIDE_DIST_DIR || ".next",
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/((?!media/).*)", headers: securityHeaders },
      // Uploads get their own, stricter policy: a stored file is only ever shown, never run or framed as a page.
      {
        source: "/media/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "default-src 'none'; sandbox" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
