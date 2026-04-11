export type StatisticsPresetId = 'today' | 'last7' | 'last30' | 'thisMonth' | 'custom';

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function endOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

/** Parse `YYYY-MM-DD` as local calendar day start. */
export function parseYmdLocalStart(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) throw new Error('Invalid date');
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

/** Parse `YYYY-MM-DD` as local calendar day end. */
export function parseYmdLocalEnd(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) throw new Error('Invalid date');
  return new Date(y, m - 1, d, 23, 59, 59, 999);
}

export function formatYmdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function getRangeForPreset(preset: Exclude<StatisticsPresetId, 'custom'>): {
  start: Date;
  end: Date;
} {
  const now = new Date();

  if (preset === 'today') {
    return { start: startOfLocalDay(now), end: endOfLocalDay(now) };
  }

  if (preset === 'last7') {
    const start = startOfLocalDay(now);
    start.setDate(start.getDate() - 6);
    return { start, end: endOfLocalDay(now) };
  }

  if (preset === 'last30') {
    const start = startOfLocalDay(now);
    start.setDate(start.getDate() - 29);
    return { start, end: endOfLocalDay(now) };
  }

  // thisMonth
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  return { start, end: endOfLocalDay(now) };
}

/**
 * UTC calendar days from `start` through `end` (inclusive), as `YYYY-MM-DD`.
 * Matches backend daily aggregation on UTC dates.
 */
export function utcDaysInclusive(start: Date, end: Date): string[] {
  const startUtc = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const endUtc = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  const out: string[] = [];
  for (let t = startUtc; t <= endUtc; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}
