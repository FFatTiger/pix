/**
 * Time-group buckets for the session list, newest first (source:
 * upstream desktop app lib/time-groups.ts, adapted to the pix SessionHeader
 * epoch-ms timestamps instead of ISO strings).
 */
export type TimeBucket = "pinned" | "today" | "yesterday" | "week" | "month" | "earlier";

export const TIME_BUCKET_ORDER: readonly TimeBucket[] = [
  "pinned",
  "today",
  "yesterday",
  "week",
  "month",
  "earlier",
];

/**
 * Bucket a `modified` epoch-ms timestamp into a time group using the
 * *local* calendar day, so "today" means the same day as the viewer's clock.
 *
 * Boundaries are calendar-day based, not rolling 24h windows:
 *   today     — same calendar day as now (future-dated sessions also land
 *               here, tolerating clock skew and timezone differences)
 *   yesterday — the previous calendar day
 *   week      — 2..7 calendar days ago
 *   month     — 8..30 calendar days ago
 *   earlier   — anything older, or an unrepresentable timestamp
 */
export function bucketOf(modified: number, now: Date = new Date()): TimeBucket {
  if (!Number.isFinite(modified)) return "earlier";
  const date = new Date(modified);
  if (Number.isNaN(date.getTime())) return "earlier";
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  // Both values are UTC milliseconds of *local* midnight, so rounding (not
  // flooring) absorbs DST transitions where a calendar day is 23/25h long.
  const diffDays = Math.round((startOfToday - startOfDay) / 86400000);
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays <= 7) return "week";
  if (diffDays <= 30) return "month";
  return "earlier";
}

/** Bucket label i18n key (en/zh parity). */
export function timeBucketKey(bucket: TimeBucket): string {
  switch (bucket) {
    case "pinned": return "desktop.groupPinned";
    case "today": return "desktop.groupToday";
    case "yesterday": return "desktop.groupYesterday";
    case "week": return "desktop.groupWeek";
    case "month": return "desktop.groupMonth";
    case "earlier": return "desktop.groupEarlier";
  }
}
