"use client";

import { Stamp, Status } from "./ui";
import { Carousel } from "./vendor/bencho-carousel";
import "./vendor/bencho-carousel.css";

const NETWORKS: Record<string, { name: string; handle: string }> = {
  x: { name: "X", handle: "@you" },
  bluesky: { name: "Bluesky", handle: "you.bsky.social" },
  threads: { name: "Threads", handle: "@you" },
  mastodon: { name: "Mastodon", handle: "@you@mastodon.social" },
  instagram: { name: "Instagram", handle: "@you" },
  tiktok: { name: "TikTok", handle: "@you" },
  youtube: { name: "YouTube", handle: "Your channel" },
  telegram: { name: "Telegram", handle: "@yourchannel" },
};

const TEXT = "We shipped it. One post, written once, sent to every network we use.";

/**
 * The hero object: one post as a card per network, on a turntable.
 * It drifts round by itself, leans under the pointer, and can be swiped or
 * turned with the arrow keys.
 */
export function HeroRing() {
  return (
    <div className="hero-ring scale-in">
      <Carousel
        spin={46}
        corner={16}
        render={(id) => (
          <span className="ring-face">
            <span className="flex items-center gap-2">
              <Stamp platform={id} />
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-semibold leading-tight">{NETWORKS[id].name}</span>
                <span className="block truncate text-[11px] leading-tight text-ink-2">{NETWORKS[id].handle}</span>
              </span>
            </span>
            <span className="mt-3 flex-1 text-[14px] leading-snug">{TEXT}</span>
            <Status status="published" />
          </span>
        )}
      />
    </div>
  );
}
