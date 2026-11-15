import type { NextConfig } from "next";

// A second build directory lets `npm run verify` build and serve without touching a server already running from .next.
const nextConfig: NextConfig = {
  distDir: process.env.BROADSIDE_DIST_DIR || ".next",
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
