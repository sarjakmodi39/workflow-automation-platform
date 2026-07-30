/**
 * Timestamps arrive as ISO strings in JSON. These render only after a client
 * fetch resolves, so locale formatting cannot produce a hydration mismatch.
 */
export function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Time of day including seconds.
 *
 * The audit trail routinely records several events inside the same minute, and
 * a timestamp that cannot separate them makes the ordering look arbitrary.
 */
export function formatTimeOfDay(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * How long a step took, from its two timestamps. Returns null when it has not
 * finished — an unfinished step has no duration, and rendering one as `0ms`
 * would claim it completed instantly.
 */
export function formatDuration(
  startedAt: string | null | undefined,
  finishedAt: string | null | undefined,
): string | null {
  if (!startedAt || !finishedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(finishedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;

  const ms = end - start;
  // Clock skew between two application instances can order these backwards.
  // Showing a negative duration would be worse than showing nothing.
  if (ms < 0) return null;
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function pluralise(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}
