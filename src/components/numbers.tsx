"use client";

import type { TargetNumbers } from "@/lib/analytics";
import type { Metric } from "@/lib/platforms/types";
import { Time } from "./ui";

/** One fixed format for counts, so the server and the browser print the same digits. */
const digits = new Intl.NumberFormat("en-US");
export const count = (value: number): string => digits.format(value);

/** A reading's counts, each under the word its network uses for it. */
export function Counts({ metrics }: { metrics: Metric[] }) {
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
      {metrics.map((m) => (
        <div key={m.kind} className="flex items-baseline gap-1.5">
          <dt className="text-ink-2">{m.label}</dt>
          <dd className="num font-medium">{count(m.value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** How far to trust a target's numbers: when they were read, what was held back, and how the latest try went. Text from a network is shown as text. */
export function Standing({ numbers }: { numbers: TargetNumbers }) {
  if (!numbers.available) {
    return <p className="note">{`Numbers are not available for ${numbers.network}. ${numbers.unavailable_reason}`}</p>;
  }
  return (
    <div className="note space-y-1">
      {numbers.as_of ? (
        <p>
          As of{" "}
          <span className="num">
            <Time iso={numbers.as_of} />
          </span>
          {numbers.metrics.length === 0 ? `. ${numbers.network} gave no counts in that reading.` : ""}
        </p>
      ) : numbers.error ? null : (
        <p>No reading yet.</p>
      )}
      {numbers.note ? <p>{numbers.note}</p> : null}
      {numbers.error ? (
        <p className="text-bad">
          The last try failed at{" "}
          <span className="num">
            <Time iso={numbers.error.at} />
          </span>
          . {numbers.error.message}
          {numbers.as_of ? " The numbers shown are from the reading before." : ""}
        </p>
      ) : null}
      {numbers.paused_until ? (
        <p>
          {numbers.network} asked Broadside to slow down. It reads this account again after{" "}
          <span className="num">
            <Time iso={numbers.paused_until} />
          </span>
          .
        </p>
      ) : null}
    </div>
  );
}
