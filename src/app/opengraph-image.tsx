import { ImageResponse } from "next/og";

export const alt = "Broadside: one post, every network";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK = "#f0f0f0";
const PAPER = "#000000";
const SIGNAL = "#e5391f";

/** The share image: the mark and the claim, set like the front page. */
export default function OpenGraphImage() {
  const sheet = (rotate: number, background: string, opacity = 1) => (
    <div style={{ position: "absolute", left: 120, top: 40, width: 120, height: 180, borderRadius: 18, background, opacity, transform: `rotate(${rotate}deg)`, transformOrigin: "60px 300px" }} />
  );
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: PAPER, color: INK, padding: 72 }}>
        <div style={{ display: "flex", position: "relative", width: 360, height: 240 }}>
          {sheet(-26, INK, 0.3)}
          {sheet(26, INK)}
          {sheet(0, SIGNAL)}
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 112, fontWeight: 500, letterSpacing: -5, lineHeight: 0.96 }}>One post for</div>
          <div style={{ fontSize: 112, fontWeight: 500, letterSpacing: -5, lineHeight: 0.96 }}>every network</div>
          <div style={{ marginTop: 28, fontSize: 34, color: "#a1a4a5" }}>Broadside. Free, open source, self-hosted.</div>
        </div>
      </div>
    ),
    size,
  );
}
