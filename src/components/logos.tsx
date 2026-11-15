import { siBluesky, siDevdotto, siDiscord, siFacebook, siGhost, siInstagram, siKick, siLemmy, siListmonk, siMastodon, siPinterest, siReddit, siTelegram, siThreads, siTiktok, siTumblr, siTwitch, siWordpress, siX, siYoutube } from "simple-icons";

/**
 * Each network's own mark, from the CC0 Simple Icons set, drawn in the
 * surrounding text colour. LinkedIn, Slack and Nostr are not in that set, so
 * they fall back to initials. The marks belong to their owners and are used
 * here only to say which network is which.
 */
const PATHS: Record<string, string> = {
  x: siX.path,
  bluesky: siBluesky.path,
  threads: siThreads.path,
  mastodon: siMastodon.path,
  instagram: siInstagram.path,
  facebook: siFacebook.path,
  tiktok: siTiktok.path,
  youtube: siYoutube.path,
  pinterest: siPinterest.path,
  tumblr: siTumblr.path,
  reddit: siReddit.path,
  telegram: siTelegram.path,
  discord: siDiscord.path,
  twitch: siTwitch.path,
  kick: siKick.path,
  lemmy: siLemmy.path,
  devto: siDevdotto.path,
  wordpress: siWordpress.path,
  ghost: siGhost.path,
  listmonk: siListmonk.path,
  // Generic glyphs for destinations that are not a brand.
  webhook: "M10 2a5 5 0 0 0-2.6 9.3l-3 5.2A3 3 0 1 0 6.1 18l4-7-1-.6A3 3 0 1 1 13 8h2a5 5 0 0 0-5-6Zm8 9a5 5 0 0 0-2 .4l-3-5.2a3 3 0 1 0-1.7 1l4 7 1-.6A3 3 0 1 1 18 19v2a5 5 0 0 0 0-10ZM6 13a5 5 0 1 0 5 5h6.2a3 3 0 1 0 0-2H9v1a3 3 0 1 1-3-3v-1Z",
  sandbox: "M12 2 3 6.5v11L12 22l9-4.5v-11L12 2Zm0 2.2 6.3 3.2L12 10.6 5.7 7.4 12 4.2ZM5 9.1l6 3v7.3l-6-3V9.1Zm14 0v7.3l-6 3v-7.3l6-3Z",
};

const INITIALS: Record<string, string> = { linkedin: "in", slack: "Sl", nostr: "No" };

export function NetworkLogo({ platform, size = 16 }: { platform: string; size?: number }) {
  const path = PATHS[platform];
  if (!path) {
    return (
      <span aria-hidden="true" style={{ fontSize: size * 0.72, fontWeight: 700, lineHeight: 1, letterSpacing: "-0.03em" }}>
        {INITIALS[platform] ?? platform.slice(0, 2)}
      </span>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}
