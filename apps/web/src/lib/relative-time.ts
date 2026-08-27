const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * Coarse wall-clock recency for list rows ("2h ago") — the Chats hub row stamp.
 * Deliberately bucketed and locale-free so it stays pure and deterministic:
 * sub-minute reads "just now", then m/h/d/w/mo/y. Unparseable input degrades to
 * "" (never throws); a future timestamp (clock skew) reads "just now".
 */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const elapsed = now - at;
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  if (elapsed < WEEK) return `${Math.floor(elapsed / DAY)}d ago`;
  if (elapsed < MONTH) return `${Math.floor(elapsed / WEEK)}w ago`;
  if (elapsed < YEAR) return `${Math.floor(elapsed / MONTH)}mo ago`;
  return `${Math.floor(elapsed / YEAR)}y ago`;
}
