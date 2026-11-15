import { dueTargets, publishTarget, recoverInterrupted } from "./posts";

type Global = typeof globalThis & { __broadsideScheduler?: ReturnType<typeof setInterval> };

/** Publishes whatever is due. Safe to call from several places at once: each target is claimed before it is sent. */
export async function tick(fetcher: typeof fetch = fetch): Promise<number> {
  const due = dueTargets();
  await Promise.all(due.map((id) => publishTarget(id, fetcher)));
  return due.length;
}

/** Starts the in-process clock once per server. No queue, no worker, no second service to run. */
export function startScheduler(): void {
  const g = globalThis as Global;
  if (g.__broadsideScheduler) return;
  recoverInterrupted();
  const every = Number(process.env.BROADSIDE_TICK_MS ?? 5000);
  g.__broadsideScheduler = setInterval(() => {
    tick().catch((error) => console.error("[broadside] scheduler tick failed:", error));
  }, every);
  g.__broadsideScheduler.unref?.();
}
