/**
 * FlipText from Obsidian UI (obsidianui.dev), MIT licensed.
 * Changed for Broadside: the wrapper is a span so it can sit inside a heading,
 * screen readers get the whole phrase once while the animated letters are hidden from them, and the class
 * helper is inlined so no extra packages are needed. The keyframes live in
 * globals.css.
 */
import type { CSSProperties } from "react";

type FlipTextProps = {
  className?: string;
  /** The text to animate, split into words by spaces. */
  children: string;
  /** Seconds each letter takes to swing into place. */
  duration?: number;
  /** Seconds before the first letter moves. */
  delay?: number;
  /** Keep flipping forever instead of once. */
  loop?: boolean;
};

export function FlipText({ className = "", children, duration = 2.2, delay = 0, loop = true }: FlipTextProps) {
  const words = children.split(" ");
  const total = children.length;
  let index = 0;
  return (
    <span className={`flip-text-wrapper ${className}`} style={{ perspective: "1000px" }}>
      <span className="sr-only">{children}</span>
      {words.map((word, w) => {
        const letters = word.split("").map((char, c) => {
          // Letters start in a sine-eased wave across the phrase rather than all at once.
          const wave = Math.sin((index++ / total) * (Math.PI / 2));
          const style = {
            "--flip-duration": `${duration}s`,
            "--flip-delay": `${(wave * duration * 0.25 + delay).toFixed(3)}s`,
            "--flip-iteration": loop ? "infinite" : "1",
            transformStyle: "preserve-3d",
          } as CSSProperties;
          return (
            <span key={c} className="flip-char relative inline-block" style={style}>
              {char}
            </span>
          );
        });
        index++;
        return (
          <span key={w} className="inline-block whitespace-nowrap" style={{ transformStyle: "preserve-3d" }} aria-hidden="true">
            {letters}
            {w < words.length - 1 ? <span className="inline-block">&nbsp;</span> : null}
          </span>
        );
      })}
    </span>
  );
}
