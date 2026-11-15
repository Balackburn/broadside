"use client";

import { useState } from "react";
import { measure, problems } from "@/lib/platforms/measure";
import type { Limits } from "@/lib/platforms/types";
import { Stamp } from "./ui";

export type FanNetwork = { id: string; name: string; limits: Limits };

const TURNS = [-18, -9, 0, 9, 18];

/**
 * The page's one live thing, and the product's real rule: type once and see
 * the same post set for each network, measured the way that network counts.
 */
export function Fan({
  networks,
  children,
}: {
  networks: FanNetwork[];
  children?: React.ReactNode;
}) {
  const [text, setText] = useState(
    "We just shipped something. One post, sent everywhere at once, and every network gets a copy that fits. https://example.com #launch",
  );
  const shown = networks.slice(0, 5);

  return (
    <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <div>
        {children}
        <div className="rise mt-10" style={{ "--i": 3 } as React.CSSProperties}>
          <label htmlFor="try" className="label">
            Try it: write a post
          </label>
          <textarea
            id="try"
            className="field min-h-36 resize-none text-[17px] leading-snug"
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={4000}
          />
          <p className="note mt-2" aria-live="polite">
            {shown.filter((n) => problems(n, text, []).length === 0).length} of{" "}
            {shown.length} networks would take this as written.
          </p>
        </div>
      </div>

      <div
        className="fan max-lg:hidden"
        aria-label="The post as each network would receive it"
      >
        {shown.map((network, n) => (
          <Sheet
            key={network.id}
            network={network}
            text={text}
            style={
              {
                "--turn": TURNS[n],
                "--n": n,
                zIndex: n + 1,
              } as React.CSSProperties
            }
            className="fan-sheet"
          />
        ))}
      </div>
      <div className="flex snap-x gap-3 overflow-x-auto pb-2 lg:hidden">
        {shown.map((network) => (
          <Sheet
            key={network.id}
            network={network}
            text={text}
            className="w-[78vw] max-w-80 flex-none snap-start"
          />
        ))}
      </div>
    </div>
  );
}

function Sheet({
  network,
  text,
  className,
  style,
}: {
  network: FanNetwork;
  text: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const length = measure(text, network.limits.count);
  const over = length > network.limits.maxChars;
  return (
    <article
      className={`sheet ${className ?? ""}`}
      data-over={over}
      style={{
        ...style,
        boxShadow: over
          ? undefined
          : "inset 0 0 0 1px var(--line), var(--float-shadow)",
      }}
    >
      <header className="mb-3 flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 font-medium">
          <Stamp platform={network.id} />
          {network.name}
        </span>
        <span
          className="num text-sm font-medium"
          style={{ color: over ? "var(--bad)" : "var(--ink-3)" }}
        >
          {length} / {network.limits.maxChars}
        </span>
      </header>
      <p className="line-clamp-6 min-h-36 whitespace-pre-wrap text-[15px] leading-snug">
        {text || "Your post appears here."}
      </p>
      <p
        className="mt-3 text-sm font-medium"
        style={{ color: over ? "var(--bad)" : "var(--good)" }}
      >
        {over
          ? `${length - network.limits.maxChars} over. Broadside would refuse this, not trim it.`
          : "Fits."}
      </p>
    </article>
  );
}
