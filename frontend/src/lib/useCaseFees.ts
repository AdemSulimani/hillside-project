import type { AdminUseCaseRow } from '@/api/platformAdminApi';

/** Minimal fields needed for progressive-tier fee display. */
export type UseCaseFeeRow = Pick<
  AdminUseCaseRow,
  'status' | 'fee_amount' | 'resolved_at'
>;

/**
 * Mirrors backend progressive tier billing for display when fee_amount has not
 * yet been stamped by the month-end billing job.
 */
export function calculateProgressiveFee(totalCases: number): number {
  if (totalCases <= 0) return 0;
  const bands = [
    { limit: 250, rate: 0.5 },
    { limit: 500, rate: 0.4 },
    { limit: 1000, rate: 0.3 },
    { limit: Infinity, rate: 0.2 },
  ];
  let remaining = totalCases;
  let fee = 0;
  let prev = 0;
  for (const band of bands) {
    const inBand = Math.min(remaining, band.limit === Infinity ? remaining : band.limit - prev);
    fee += inBand * band.rate;
    remaining -= inBand;
    prev = band.limit === Infinity ? prev : band.limit;
    if (remaining <= 0) break;
  }
  return Math.round(fee * 100) / 100;
}

/** UTC calendar month key (YYYY-MM) — matches backend billing period grouping. */
export function toBillingMonth(resolvedAt: string): string {
  const d = new Date(resolvedAt);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** Count completed, non-voided use cases per billing month. */
export function buildCompletedCountsByMonth(useCases: UseCaseFeeRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const uc of useCases) {
    if (uc.status !== 'completed') continue;
    const month = toBillingMonth(uc.resolved_at);
    counts.set(month, (counts.get(month) ?? 0) + 1);
  }
  return counts;
}

/**
 * Fee shown in the admin table: stamped amount when present, otherwise the
 * per-case average for the billing month (same approach as the stamp-fees job).
 */
export function getUseCaseDisplayFee(
  uc: UseCaseFeeRow,
  countsByMonth: Map<string, number>,
): number | null {
  if (uc.status === 'voided') return null;
  if (uc.fee_amount != null) return uc.fee_amount;

  const count = countsByMonth.get(toBillingMonth(uc.resolved_at)) ?? 0;
  if (count <= 0) return null;

  const totalFee = calculateProgressiveFee(count);
  return Math.round((totalFee / count) * 100) / 100;
}
