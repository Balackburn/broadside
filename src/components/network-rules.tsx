"use client";

import { useState } from "react";
import type { Limits } from "@/lib/platforms/types";
import { NetworkLogo } from "./logos";

export type RuleNetwork = { id: string; name: string; setup: string[]; limits: Limits; brings: string };

const number = new Intl.NumberFormat("en");

function media(limits: Limits): string {
  const parts = [limits.maxImages ? `${limits.maxImages} image${limits.maxImages > 1 ? "s" : ""}` : "", limits.maxVideos ? "1 video" : ""].filter(Boolean);
  if (!parts.length) return "Text only";
  return `${parts.join(" or ")}${limits.requiresMedia ? ", required" : ""}`;
}

/** Pick a network to see what it accepts and what you need to connect it. */
export function NetworkRules({ networks }: { networks: RuleNetwork[] }) {
  const [picked, setPicked] = useState(networks[0].id);
  const network = networks.find((n) => n.id === picked) ?? networks[0];
  const facts: [string, string][] = [
    ["Characters", number.format(network.limits.maxChars)],
    ["Media", media(network.limits)],
    ["You bring", network.brings],
  ];

  return (
    <div className="glass">
      <div className="grid grid-cols-3 gap-1 p-3 sm:grid-cols-6 lg:grid-cols-9" role="tablist" aria-label="Networks">
        {networks.map((n) => (
          <button key={n.id} type="button" role="tab" className="logo-cell" aria-selected={n.id === picked} onClick={() => setPicked(n.id)}>
            <NetworkLogo platform={n.id} size={22} />
            <span>{n.name}</span>
          </button>
        ))}
      </div>
      <div className="grid gap-8 p-6 sm:p-8 lg:grid-cols-[minmax(0,4fr)_minmax(0,6fr)]" role="tabpanel" key={network.id}>
        <dl className="swap grid grid-cols-3 gap-4 lg:grid-cols-1">
          {facts.map(([term, value]) => (
            <div key={term}>
              <dt className="text-sm text-ink-3">{term}</dt>
              <dd className="num mt-1 text-xl font-medium tracking-tight">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="swap">
          <p className="text-sm text-ink-3">How to connect {network.name}</p>
          <ol className="mt-3 list-decimal space-y-2 pl-5 leading-snug text-ink-2">
            {network.setup.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}
