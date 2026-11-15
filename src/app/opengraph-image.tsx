import { ImageResponse } from "next/og";

export const alt = "Broadside: one post, every network";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK = "#f0ede5";
const PAPER = "#000000";
const SIGNAL = "#f0503a";

/** The share image: the mark and the claim, set like the front page. */
export default function OpenGraphImage() {
  const bar = (rotate: number) => (
    <div style={{ position: "absolute", left: 96, top: 92, width: 150, height: 50, borderRadius: 25, background: INK, transform: `rotate(${rotate}deg)`, transformOrigin: "8px 25px" }} />
  );
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: PAPER, color: INK, padding: 72 }}>
        <div style={{ display: "flex", position: "relative", width: 360, height: 240 }}>
          <div style={{ position: "absolute", left: 20, top: 27, width: 50, height: 180, borderRadius: 25, background: SIGNAL }} />
          {bar(-36)}
          {bar(0)}
          {bar(36)}
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
