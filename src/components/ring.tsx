"use client";

import { useEffect, useRef, useState } from "react";
import { Stamp, Status } from "./ui";

export type RingCard = { id: string; name: string; handle: string };

/**
 * The hero object: the same post as a card per network, standing in a ring
 * that turns slowly and leans toward the pointer. It stops turning when it is
 * off screen, and it does not move at all under reduced motion.
 */
export function Ring({ cards, text }: { cards: RingCard[]; text: string }) {
  const stage = useRef<HTMLDivElement>(null);
  const tilt = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const el = stage.current;
    const lean = tilt.current;
    if (!el || !lean) return;
    const watcher = new IntersectionObserver(([entry]) => setPaused(!entry.isIntersecting));
    watcher.observe(el);
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches || !matchMedia("(hover: hover) and (pointer: fine)").matches;
    if (still) return () => watcher.disconnect();

    // The lean eases toward the pointer and stops asking for frames once it has settled.
    let targetX = 0;
    let targetY = 0;
    let x = 0;
    let y = 0;
    let frame = 0;
    const step = () => {
      x += (targetX - x) * 0.08;
      y += (targetY - y) * 0.08;
      lean.style.transform = `translateZ(-330px) rotateX(${-7 + y}deg) rotateY(${x}deg)`;
      frame = Math.abs(targetX - x) > 0.01 || Math.abs(targetY - y) > 0.01 ? requestAnimationFrame(step) : 0;
    };
    const wake = () => {
      if (!frame) frame = requestAnimationFrame(step);
    };
    const move = (event: PointerEvent) => {
      const box = el.getBoundingClientRect();
      targetX = ((event.clientX - box.left) / box.width - 0.5) * 12;
      targetY = ((event.clientY - box.top) / box.height - 0.5) * -8;
      wake();
    };
    const leave = () => {
      targetX = 0;
      targetY = 0;
      wake();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    return () => {
      watcher.disconnect();
      cancelAnimationFrame(frame);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
    };
  }, []);

  return (
    <div className="relative">
      <div className="floor" />
      <div className="ring-stage scale-in" ref={stage} role="img" aria-label={`The same post shown as it appears on ${cards.map((c) => c.name).join(", ")}`}>
        <div className="ring-tilt" ref={tilt}>
          <div className="ring" data-paused={paused}>
            {cards.map((card, i) => (
              <article key={card.id} className="ring-card flex flex-col" style={{ "--i": i } as React.CSSProperties} aria-hidden="true">
                <header className="flex items-center gap-2">
                  <Stamp platform={card.id} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{card.name}</span>
                    <span className="block truncate text-xs text-ink-3">{card.handle}</span>
                  </span>
                </header>
                <p className="mt-4 flex-1 text-[15px] leading-snug">{text}</p>
                <Status status="published" />
              </article>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
