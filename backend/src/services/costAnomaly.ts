/**
 * P3-6 — the COGS anomaly detector, as a pure function.
 *
 * Pure and leaf (no imports at all) so every threshold and every hysteresis transition is
 * unit-testable without a database, a clock or Redis — the same discipline as
 * `services/shadowComparison.ts`. The IO half (querying the rollup, dispatching to Sentry and the
 * ops webhook) lives in `services/costAnomalyMonitor.ts`.
 *
 * THE DEFAULT-OFF GUARANTEE, stated as an invariant rather than a hope: every threshold is `0` /
 * `false` by default, and a `0` threshold means "never fire" — not "fire on everything", which is
 * the reading a naive `measure >= threshold` would produce and is exactly how a monitoring
 * feature ships as an alert storm on day one.
 */

export type CostAnomalyKind =
  | 'margin_inversion'
  | 'runaway_conversation'
  | 'turn_call_spike'
  | 'model_drift'
  | 'unpriced_model';

export interface CostAnomaly {
  kind: CostAnomalyKind;
  tenantId: string;
  /** Stable within a (tenant, period, kind) so the dispatcher can dedupe on it. */
  scope: string;
  measure: number;
  threshold: number;
  detail: Record<string, string | number>;
}

export interface CostAnomalyThresholds {
  /** COGS / revenue ratio at which a tenant is flagged. 0 = off. */
  marginRatio: number;
  /** USD spend on a single conversation. 0 = off. */
  conversationUsd: number;
  /** OpenAI calls in a single turn. 0 = off. */
  turnCalls: number;
  /** Model-drift + unpriced-model detection (no numeric threshold). */
  modelDrift: boolean;
}

export interface TenantCostFacts {
  tenantId: string;
  period: string;
  /** Total COGS for the period, USD. */
  usdCost: number;
  /** Commission + use-case fees billed for the same period, EUR-denominated but compared as-is. */
  revenue: number;
  /** Chat calls whose model had no price entry — the total above understates by this much. */
  unpricedCalls: number;
  /** Distinct served-model ids seen for the same role, keyed by role. */
  modelsByRole: Record<string, string[]>;
  /** The worst single conversation in the period. */
  worstConversation?: { conversationId: string; usdCost: number } | null;
  /** The worst single turn in the period. */
  worstTurn?: { conversationId: string | null; calls: number } | null;
}

/**
 * Decide which anomalies a tenant's period exhibits.
 *
 * `previouslyTripped` carries the kinds already firing, so a threshold that has been crossed does
 * not re-fire until the measure falls back under `threshold * rearmFactor`. Without that, a ratio
 * sitting at 1.01 against a threshold of 1.0 alerts on every single tick.
 */
export function detectCostAnomalies(
  facts: TenantCostFacts,
  thresholds: CostAnomalyThresholds,
  previouslyTripped: ReadonlySet<CostAnomalyKind> = new Set(),
  rearmFactor = 0.9,
): CostAnomaly[] {
  const out: CostAnomaly[] = [];

  /**
   * A measure fires when it reaches the threshold — unless the kind is already tripped, in which
   * case it must first fall below `threshold * rearmFactor` to re-arm. Returns false for a
   * threshold of 0, which is the off switch.
   */
  const crosses = (kind: CostAnomalyKind, measure: number, threshold: number): boolean => {
    if (threshold <= 0) return false;
    if (previouslyTripped.has(kind)) return false;
    return measure >= threshold;
  };

  if (thresholds.marginRatio > 0) {
    // Revenue of 0 with any spend is an infinite ratio; report the spend as the measure so the
    // alert text carries a real number rather than `Infinity`.
    const ratio = facts.revenue > 0 ? facts.usdCost / facts.revenue : facts.usdCost > 0 ? Infinity : 0;
    if (crosses('margin_inversion', ratio, thresholds.marginRatio)) {
      out.push({
        kind: 'margin_inversion',
        tenantId: facts.tenantId,
        scope: `${facts.tenantId}:${facts.period}`,
        measure: Number.isFinite(ratio) ? Math.round(ratio * 1000) / 1000 : facts.usdCost,
        threshold: thresholds.marginRatio,
        detail: {
          period: facts.period,
          usd_cost: facts.usdCost,
          revenue: facts.revenue,
          zero_revenue: facts.revenue > 0 ? 'no' : 'yes',
        },
      });
    }
  }

  const worstConv = facts.worstConversation;
  if (worstConv && crosses('runaway_conversation', worstConv.usdCost, thresholds.conversationUsd)) {
    out.push({
      kind: 'runaway_conversation',
      tenantId: facts.tenantId,
      scope: `${facts.tenantId}:${worstConv.conversationId}`,
      measure: worstConv.usdCost,
      threshold: thresholds.conversationUsd,
      detail: { period: facts.period, conversation_id: worstConv.conversationId },
    });
  }

  const worstTurn = facts.worstTurn;
  if (worstTurn && crosses('turn_call_spike', worstTurn.calls, thresholds.turnCalls)) {
    out.push({
      kind: 'turn_call_spike',
      tenantId: facts.tenantId,
      scope: `${facts.tenantId}:${facts.period}:turn`,
      measure: worstTurn.calls,
      threshold: thresholds.turnCalls,
      detail: {
        period: facts.period,
        conversation_id: worstTurn.conversationId ?? 'unknown',
        // Names the likely cause so the alert is actionable rather than merely true.
        likely_cause: 'uncached per-message classifier loop (C-126) or a retry storm',
      },
    });
  }

  if (thresholds.modelDrift && !previouslyTripped.has('model_drift')) {
    for (const [role, models] of Object.entries(facts.modelsByRole)) {
      const distinct = [...new Set(models)];
      if (distinct.length > 1) {
        out.push({
          kind: 'model_drift',
          tenantId: facts.tenantId,
          scope: `${facts.tenantId}:${facts.period}:${role}`,
          measure: distinct.length,
          threshold: 1,
          detail: {
            period: facts.period,
            role,
            models: distinct.join(', '),
            // RC-17: the 900s delete-only ai_config cache can serve a stale custom_model_id, so
            // two workers answer the same tenant on different models. Invisible until P1-5
            // captured model-id per call; this is the check that makes it alertable.
            likely_cause: 'RC-17 ai_config cache drift or a mid-window model reconfiguration',
          },
        });
        break;
      }
    }
  }

  if (
    thresholds.modelDrift &&
    facts.unpricedCalls > 0 &&
    !previouslyTripped.has('unpriced_model')
  ) {
    out.push({
      kind: 'unpriced_model',
      tenantId: facts.tenantId,
      scope: `${facts.tenantId}:${facts.period}:unpriced`,
      measure: facts.unpricedCalls,
      threshold: 1,
      detail: {
        period: facts.period,
        // The direction matters: an unpriced call is counted but costs 0, so the reported total
        // is LOW. A cost report drifting downward for a config reason reads as a win.
        impact: 'reported COGS understates actual spend',
        fix: 'add the model to modelPricing DEFAULT_PRICES or OPENAI_MODEL_PRICES',
      },
    });
  }

  return out;
}

/**
 * Which kinds should re-arm, given the current measures. Called with the same facts on the next
 * tick: a kind re-arms once its measure drops below `threshold * rearmFactor`.
 */
export function rearmedKinds(
  facts: TenantCostFacts,
  thresholds: CostAnomalyThresholds,
  tripped: ReadonlySet<CostAnomalyKind>,
  rearmFactor = 0.9,
): CostAnomalyKind[] {
  const out: CostAnomalyKind[] = [];
  const under = (measure: number, threshold: number): boolean =>
    threshold <= 0 || measure < threshold * rearmFactor;

  const ratio = facts.revenue > 0 ? facts.usdCost / facts.revenue : facts.usdCost > 0 ? Infinity : 0;
  if (tripped.has('margin_inversion') && under(ratio, thresholds.marginRatio)) {
    out.push('margin_inversion');
  }
  if (
    tripped.has('runaway_conversation') &&
    under(facts.worstConversation?.usdCost ?? 0, thresholds.conversationUsd)
  ) {
    out.push('runaway_conversation');
  }
  if (tripped.has('turn_call_spike') && under(facts.worstTurn?.calls ?? 0, thresholds.turnCalls)) {
    out.push('turn_call_spike');
  }
  if (tripped.has('unpriced_model') && facts.unpricedCalls === 0) out.push('unpriced_model');
  if (
    tripped.has('model_drift') &&
    Object.values(facts.modelsByRole).every((m) => new Set(m).size <= 1)
  ) {
    out.push('model_drift');
  }
  return out;
}
