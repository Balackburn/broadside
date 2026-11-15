/**
 * When a repeating post comes round again. Every date is counted from the
 * series' first occurrence (the anchor), never from the one before, so a
 * monthly post set for the 31st lands on the last day of a short month and
 * goes back to the 31st afterwards. With a time zone the wall-clock time is
 * held across daylight-saving changes; without one the arithmetic is in UTC.
 */

export type Every = "day" | "week" | "month";
export const EVERY: Every[] = ["day", "week", "month"];

const formats = new Map<string, Intl.DateTimeFormat>();

/** Throws RangeError for a name that is not an IANA time zone. */
function format(zone: string): Intl.DateTimeFormat {
  let found = formats.get(zone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formats.set(zone, found);
  }
  return found;
}

export function isTimeZone(zone: string): boolean {
  try {
    format(zone);
    return true;
  } catch {
    return false;
  }
}

/** The calendar fields a clock on the wall in `zone` shows at this instant. Months count from 0. */
function wall(ms: number, zone: string): [year: number, month: number, day: number, hour: number, minute: number, second: number] {
  const parts: Record<string, number> = {};
  for (const { type, value } of format(zone).formatToParts(new Date(ms))) parts[type] = Number(value);
  return [parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second];
}

/** How far `zone` is ahead of UTC at this instant, in milliseconds. */
const offset = (ms: number, zone: string): number => Date.UTC(...wall(ms, zone)) - Math.floor(ms / 1000) * 1000;

/** The time of the occurrence `count` steps after the anchor, as an ISO string. Count 0 is the anchor itself. */
export function occurrence(anchor: string, every: Every, count: number, zone = "UTC"): string {
  const start = new Date(anchor).getTime();
  const [year, month, day, hour, minute, second] = wall(start, zone);
  let m = month;
  let d = day;
  if (every === "month") {
    m = month + count;
    // Day 0 of the following month is the last day of this one.
    d = Math.min(day, new Date(Date.UTC(year, m + 1, 0)).getUTCDate());
  } else {
    d = day + count * (every === "week" ? 7 : 1);
  }
  const asUtc = Date.UTC(year, m, d, hour, minute, second);
  // The zone's offset on the target day may differ from the anchor's; the second pass settles a date that falls on a change.
  const first = asUtc - offset(asUtc, zone);
  return new Date(asUtc - offset(first, zone) + (start % 1000)).toISOString();
}

/**
 * The next occurrence after number `count` that is still in the future, or
 * null when the series ends first. Occurrences missed while Broadside was not
 * running are skipped: a week of downtime does not send seven posts at once.
 */
export function nextOccurrence(rule: { anchor: string; every: Every; zone?: string | null; until?: string | null }, count: number, after: number): { at: string; count: number } | null {
  for (let next = count + 1; next < count + 5000; next++) {
    const at = occurrence(rule.anchor, rule.every, next, rule.zone ?? "UTC");
    if (rule.until && at > rule.until) return null;
    if (new Date(at).getTime() > after) return { at, count: next };
  }
  return null;
}
