import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = (process.env.BROADSIDE_PUBLIC_URL || "http://localhost:3000").replace(/\/+$/, "");
  return [{ url: `${base}/`, changeFrequency: "monthly", priority: 1 }];
}
