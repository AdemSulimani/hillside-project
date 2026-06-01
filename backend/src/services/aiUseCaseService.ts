import type { PoolClient } from 'pg';
import pool from '../db/pool';
import {
  countAiUseCasesForTenantInPeriod,
  createAiUseCase,
  findAiUseCaseByConversation,
  findAiUseCaseById,
  stampMissingFeesForTenantInBillingMonth,
  updateAiUseCaseBillingStatus,
  type AiUseCase,
  type AiUseCaseBillingStatus,
} from '../db/models/aiUseCase';

/** Minimum number of AI outbound messages for a conversation to be a billable use case. */
const MIN_AI_MESSAGES = 1;

export interface UseCaseTier {
  label: string;
  rate: number;
  lowerBound: number;
  upperBound: number;
}

const TIERS: UseCaseTier[] = [
  { label: '0–250', rate: 0.5, lowerBound: 0, upperBound: 250 },
  { label: '251–500', rate: 0.4, lowerBound: 251, upperBound: 500 },
  { label: '501–1000', rate: 0.3, lowerBound: 501, upperBound: 1000 },
  { label: '1000+', rate: 0.2, lowerBound: 1001, upperBound: Infinity },
];

/**
 * Returns the pricing tier object that applies to the given total case count.
 * The tier is determined by the highest band the count falls into.
 */
export function getTierForCount(count: number): UseCaseTier {
  for (let i = TIERS.length - 1; i >= 0; i--) {
    if (count > TIERS[i].lowerBound - 1) return TIERS[i];
  }
  return TIERS[0];
}

/**
 * Calculates the total fee for a given number of use cases using progressive band billing.
 * Each band's cases are charged at that band's rate (identical to income tax brackets).
 *
 * Example: 600 cases
 *   = (250 × 0.50) + (250 × 0.40) + (100 × 0.30)
 *   = €125.00 + €100.00 + €30.00
 *   = €255.00
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

/** Per-case fee using the full month's volume for progressive tier pricing. */
export function perCaseFeeForMonthTotal(totalCasesInMonth: number): number {
  if (totalCasesInMonth <= 0) return 0;
  return Math.round((calculateProgressiveFee(totalCasesInMonth) / totalCasesInMonth) * 100) / 100;
}

/** Outstanding use case fees for one month (billed + projected unbilled). */
export function outstandingUseCaseFeesForMonth(
  unbilledCount: number,
  totalCasesInMonth: number,
  billedFeeSum: number,
): number {
  let total = billedFeeSum;
  if (unbilledCount > 0 && totalCasesInMonth > 0) {
    total += perCaseFeeForMonthTotal(totalCasesInMonth) * unbilledCount;
  }
  return Math.round(total * 100) / 100;
}

/** UTC calendar month key (YYYY-MM) from a resolved_at timestamp. */
export function billingPeriodFromResolvedAt(resolvedAt: Date): string {
  const y = resolvedAt.getUTCFullYear();
  const m = String(resolvedAt.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** Inclusive UTC range for a billing period month key. */
export function billingPeriodToUtcRange(billingPeriod: string): {
  start: Date;
  endExclusive: Date;
} {
  const [yearStr, monthStr] = billingPeriod.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    endExclusive: new Date(Date.UTC(year, month, 1)),
  };
}

/** Per-case fee for a tenant's billing month using progressive tier totals. */
export async function computeFeePerCaseForTenantBillingMonth(
  tenantId: string,
  billingPeriod: string,
  client: PoolClient | typeof pool = pool,
): Promise<number> {
  const { start, endExclusive } = billingPeriodToUtcRange(billingPeriod);
  const count = await countAiUseCasesForTenantInPeriod(tenantId, start, endExclusive, client);
  if (count <= 0) return 0;
  const totalFee = calculateProgressiveFee(count);
  return Math.round((totalFee / count) * 100) / 100;
}

/**
 * Stamps fee_amount on any completed use cases in the billing month that are
 * missing a fee. Uses the same progressive-tier average as the month-end job.
 */
export async function ensureTenantBillingMonthFeesStamped(
  tenantId: string,
  billingPeriod: string,
  client: PoolClient | typeof pool = pool,
): Promise<void> {
  const feePerCase = await computeFeePerCaseForTenantBillingMonth(tenantId, billingPeriod, client);
  if (feePerCase <= 0) return;

  const { start, endExclusive } = billingPeriodToUtcRange(billingPeriod);
  await stampMissingFeesForTenantInBillingMonth(
    tenantId,
    billingPeriod,
    start,
    endExclusive,
    feePerCase,
    client,
  );
}

/**
 * Backfills missing fees for all billed/paid use cases belonging to a tenant.
 */
export async function ensureStampedFeesForInvoicedUseCasesForTenant(tenantId: string): Promise<void> {
  const { rows } = await pool.query<{ billing_month: string }>(
    `SELECT DISTINCT to_char(date_trunc('month', resolved_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS billing_month
     FROM ai_use_cases
     WHERE tenant_id = $1
       AND status = 'completed'
       AND billing_status IN ('billed', 'paid')
       AND fee_amount IS NULL`,
    [tenantId],
  );

  for (const { billing_month } of rows) {
    await ensureTenantBillingMonthFeesStamped(tenantId, billing_month);
  }
}

/**
 * Backfills missing fees for billed/paid use cases whose resolved_at falls in range.
 */
export async function ensureStampedFeesForInvoicedUseCasesInPeriod(
  tenantId: string,
  rangeStartInclusive: Date,
  rangeEndExclusive: Date,
): Promise<void> {
  const { rows } = await pool.query<{ billing_month: string }>(
    `SELECT DISTINCT to_char(date_trunc('month', resolved_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS billing_month
     FROM ai_use_cases
     WHERE tenant_id = $1
       AND status = 'completed'
       AND billing_status IN ('billed', 'paid')
       AND fee_amount IS NULL
       AND resolved_at >= $2
       AND resolved_at < $3`,
    [tenantId, rangeStartInclusive, rangeEndExclusive],
  );

  for (const { billing_month } of rows) {
    await ensureTenantBillingMonthFeesStamped(tenantId, billing_month);
  }
}

/**
 * Admin billing status update — stamps fees when marking invoiced or paid so
 * period stats and aggregates reflect the correct totals.
 */
export async function updateAdminUseCaseBillingStatus(
  id: string,
  billingStatus: AiUseCaseBillingStatus,
): Promise<AiUseCase | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await findAiUseCaseById(id, client);
    if (!existing) {
      await client.query('ROLLBACK');
      return null;
    }

    if (
      existing.status === 'completed' &&
      (billingStatus === 'billed' || billingStatus === 'paid')
    ) {
      const billingPeriod = billingPeriodFromResolvedAt(existing.resolved_at);
      await ensureTenantBillingMonthFeesStamped(existing.tenant_id, billingPeriod, client);
    }

    const updated = await updateAiUseCaseBillingStatus(id, billingStatus, client);
    await client.query('COMMIT');
    return updated;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface BillabilityCheckResult {
  billable: boolean;
  reason: string;
}

/**
 * Determines whether a conversation qualifies as a billable AI use case.
 * All conditions must pass:
 *  - No human agent ever replied (human_replied = false)
 *  - AI was not paused (ai_paused = false)
 *  - No human_override_until was ever set (humanOverrideUntil is null)
 *  - At least MIN_AI_MESSAGES outbound AI messages exist in the conversation
 *  - No confirmed/processing/shipped/delivered order exists for the conversation
 */
export async function checkConversationBillability(
  conversationId: string,
  tenantId: string,
  client: PoolClient | typeof pool = pool,
): Promise<BillabilityCheckResult> {
  const { rows } = await client.query<{
    human_replied: boolean;
    ai_paused: boolean;
    human_override_until: Date | null;
    ai_message_count: string;
    confirmed_order_count: string;
  }>(
    `SELECT
       c.human_replied,
       c.ai_paused,
       c.human_override_until,
       (
         SELECT COUNT(*)::text
         FROM messages m
         WHERE m.conversation_id = c.id
           AND m.sent_by = 'ai'
       ) AS ai_message_count,
       (
         SELECT COUNT(*)::text
         FROM orders o
         WHERE o.conversation_id = c.id
           AND o.tenant_id = c.tenant_id
           AND o.status IN ('confirmed', 'processing', 'shipped', 'delivered')
       ) AS confirmed_order_count
     FROM conversations c
     WHERE c.id = $1 AND c.tenant_id = $2
     LIMIT 1`,
    [conversationId, tenantId],
  );

  const row = rows[0];
  if (!row) {
    return { billable: false, reason: 'conversation_not_found' };
  }

  if (row.human_replied) {
    return { billable: false, reason: 'human_replied' };
  }

  if (row.ai_paused) {
    return { billable: false, reason: 'ai_paused' };
  }

  if (row.human_override_until !== null) {
    return { billable: false, reason: 'human_override_set' };
  }

  if (parseInt(row.ai_message_count, 10) < MIN_AI_MESSAGES) {
    return { billable: false, reason: 'insufficient_ai_messages' };
  }

  if (parseInt(row.confirmed_order_count, 10) > 0) {
    return { billable: false, reason: 'order_exists' };
  }

  return { billable: true, reason: 'ok' };
}

/**
 * Evaluates a conversation for billability and creates an ai_use_cases row if it qualifies.
 * Idempotent: the UNIQUE constraint on conversation_id prevents double-creation.
 * Returns the created use case, or null if the conversation is not billable or was already recorded.
 */
export async function checkAndCreateUseCase(
  conversationId: string,
  tenantId: string,
  contactId: string,
): Promise<AiUseCase | null> {
  const existing = await findAiUseCaseByConversation(conversationId);
  if (existing) {
    return null;
  }

  const result = await checkConversationBillability(conversationId, tenantId);
  if (!result.billable) {
    console.info('[use-case] Conversation not billable', {
      conversationId,
      tenantId,
      reason: result.reason,
    });
    return null;
  }

  const useCase = await createAiUseCase({
    tenant_id: tenantId,
    conversation_id: conversationId,
    contact_id: contactId,
    resolved_at: new Date(),
  });

  if (useCase) {
    console.info('[use-case] Billable use case recorded', {
      useCaseId: useCase.id,
      conversationId,
      tenantId,
    });
  }

  return useCase;
}

/**
 * Returns the current month's use case count and projected fee for a tenant.
 * Used by the /api/credits/tier-status endpoint.
 */
export async function getTierStatusForTenant(tenantId: string): Promise<{
  current_count: number;
  current_tier: UseCaseTier;
  projected_fee: number;
  next_tier: UseCaseTier | null;
  cases_to_next_tier: number | null;
}> {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const [countResult, outstandingResult] = await Promise.all([
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM ai_use_cases
       WHERE tenant_id = $1
         AND status = 'completed'
         AND resolved_at >= $2
         AND resolved_at < $3`,
      [tenantId, monthStart, monthEnd],
    ),
    pool.query<{
      unbilled_count: string;
      total_count: string;
      billed_fees: string;
    }>(
      `WITH month_totals AS (
         SELECT COUNT(*)::text AS total_count
         FROM ai_use_cases
         WHERE tenant_id = $1
           AND status = 'completed'
           AND resolved_at >= $2
           AND resolved_at < $3
       ),
       outstanding AS (
         SELECT
           COUNT(*) FILTER (WHERE billing_status = 'unbilled')::text AS unbilled_count,
           COALESCE(
             SUM(fee_amount) FILTER (WHERE billing_status = 'billed'),
             0
           )::text AS billed_fees
         FROM ai_use_cases
         WHERE tenant_id = $1
           AND status = 'completed'
           AND billing_status IN ('unbilled', 'billed')
           AND resolved_at >= $2
           AND resolved_at < $3
       )
       SELECT o.unbilled_count, mt.total_count, o.billed_fees
       FROM outstanding o, month_totals mt`,
      [tenantId, monthStart, monthEnd],
    ),
  ]);

  const currentCount = parseInt(countResult.rows[0]?.count ?? '0', 10);
  const currentTier = getTierForCount(currentCount);
  const outstandingRow = outstandingResult.rows[0];
  const projectedFee = outstandingRow
    ? outstandingUseCaseFeesForMonth(
        parseInt(outstandingRow.unbilled_count, 10),
        parseInt(outstandingRow.total_count, 10),
        parseFloat(outstandingRow.billed_fees),
      )
    : 0;
  const currentTierIndex = TIERS.indexOf(currentTier);
  const nextTier = currentTierIndex < TIERS.length - 1 ? TIERS[currentTierIndex + 1] : null;
  const casesToNextTier = nextTier ? nextTier.lowerBound - currentCount : null;

  return {
    current_count: currentCount,
    current_tier: currentTier,
    projected_fee: projectedFee,
    next_tier: nextTier,
    cases_to_next_tier: casesToNextTier,
  };
}
