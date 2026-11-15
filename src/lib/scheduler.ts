import { collectDue } from "./analytics";
import { checkDueFeeds } from "./feeds";
import { deliverDue } from "./outgoing";
import { dueTargets, publishTarget, recoverInterrupted } from "./posts";

type Global = typeof globalThis & { __broadsideScheduler?: ReturnType<typeof setInterval>; __broadsideReading?: boolean; __broadsideDelivering?: boolean; __broadsideFeeds?: boolean };

/** Publishes whatever is due. Safe to call from several places at once: each target is claimed before it is sent. */
export async function tick(fetcher: typeof fetch = fetch): Promise<number> {
  const due = dueTargets();
  await Promise.all(due.map((id) => publishTarget(id, fetcher)));
  return due.length;
}

/**
 * Reads the numbers of a few published posts. It runs beside `tick`, never
 * inside it: the clock starts both and waits for neither, so a network that
 * is slow to report numbers cannot hold up a post that is due. One sweep runs
 * at a time in this process; a call that finds one under way does nothing.
 */
export async function readNumbers(fetcher: typeof fetch = fetch): Promise<number> {
  const g = globalThis as Global;
  if (g.__broadsideReading) return 0;
  g.__broadsideReading = true;
  try {
    return (await collectDue(fetcher)).length;
  } finally {
    g.__broadsideReading = false;
  }
}

/**
 * Sends the outgoing webhook deliveries that are due. Like `readNumbers` it
 * runs beside `tick` and is never awaited by it: a receiver that is slow or
 * down delays other deliveries at most, and never a post. One sweep at a time
 * in this process.
 */
export async function deliverWebhooks(fetcher: typeof fetch = fetch): Promise<number> {
  const g = globalThis as Global;
  if (g.__broadsideDelivering) return 0;
  g.__broadsideDelivering = true;
  try {
    return (await deliverDue(fetcher)).length;
  } finally {
    g.__broadsideDelivering = false;
  }
}

/**
 * Reads the feeds that are due, each at most once every fifteen minutes, and
 * turns their new items into posts. Beside `tick`, never inside it, and one
 * sweep at a time in this process.
 */
export async function checkFeeds(fetcher: typeof fetch = fetch): Promise<number> {
  const g = globalThis as Global;
  if (g.__broadsideFeeds) return 0;
  g.__broadsideFeeds = true;
  try {
    return (await checkDueFeeds(fetcher)).length;
  } finally {
    g.__broadsideFeeds = false;
  }
}

/** Starts the in-process clock once per server. No queue, no worker, no second service to run. */
export function startScheduler(): void {
  const g = globalThis as Global;
  if (g.__broadsideScheduler) return;
  recoverInterrupted();
  const every = Number(process.env.BROADSIDE_TICK_MS ?? 5000);
  g.__broadsideScheduler = setInterval(() => {
    tick().catch((error) => console.error("[broadside] scheduler tick failed:", error));
    readNumbers().catch((error) => console.error("[broadside] reading numbers failed:", (error as Error).message));
    deliverWebhooks().catch((error) => console.error("[broadside] outgoing webhook deliveries failed:", (error as Error).message));
    checkFeeds().catch((error) => console.error("[broadside] checking feeds failed:", (error as Error).message));
  }, every);
  g.__broadsideScheduler.unref?.();
}
