const SECOND_MS = 1_000;
const MINUTE_S = 60;
const HOUR_S = 3_600;
const DAY_S = 86_400;

/** Local wall-clock time as zero-padded 24h "HH:MM". */
export function formatClock(ts: number): string {
  const date = new Date(ts);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/**
 * Floors to whole seconds and prints the two largest non-zero units, e.g.
 * "45s", "1m 30s", "1h 30m", "2d 3h". Sub-second durations render as "0s".
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / SECOND_MS);
  if (totalSeconds < 1) return "0s";

  const days = Math.floor(totalSeconds / DAY_S);
  const hours = Math.floor((totalSeconds % DAY_S) / HOUR_S);
  const minutes = Math.floor((totalSeconds % HOUR_S) / MINUTE_S);
  const seconds = totalSeconds % MINUTE_S;

  const units: string[] = [];
  if (days > 0) units.push(`${days}d`);
  if (hours > 0) units.push(`${hours}h`);
  if (minutes > 0) units.push(`${minutes}m`);
  if (seconds > 0) units.push(`${seconds}s`);
  return units.slice(0, 2).join(" ");
}

/**
 * Replaces `{key}` placeholders whose key exists in `vars`; unknown
 * placeholders are left verbatim so users can see the broken template.
 */
export function renderTemplate(
  template: string,
  vars: Readonly<Record<string, string>>,
): string {
  return template.replace(/\{([a-z_]+)\}/g, (match, key: string) => {
    return Object.hasOwn(vars, key) ? vars[key]! : match;
  });
}
