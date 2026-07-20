/**
 * P3-5 (RC-26): surface prompt-assembly governance failures as durable, deduped alerts.
 *
 * WHY THIS EXISTS. P2-5's allowlist already REJECTS the orphan `guidelines.offers_promotions` —
 * but only into a `console.warn`, and a console.warn is exactly how a block referencing a
 * nonexistent "Active offers" section survived unnoticed in 6/6 tenants' every reply for months.
 * The item's acceptance is "rejected AND alerted", not "rejected".
 *
 * DEDUP IS KEYED STRUCTURALLY, NOT ON A TTL. These conditions are structural: an orphan block is
 * enabled or it is not, and it is enabled on every reply. A plain rate limit would still emit one
 * alert per window forever, and a naive implementation emits one per reply per tenant — hundreds a
 * day of a fact that has not changed. Keying on (tenant, kind, detail, catalog marker) means
 * exactly ONE alert per catalog epoch: it fires when the condition appears, stays quiet while it
 * persists, and fires again only if the catalog moves and the problem survives the move. When
 * someone fixes the block the condition stops occurring, so the alert stops — it self-clears with
 * no expiry logic at all. The Redis TTL below is garbage collection, not the dedup mechanism.
 *
 * FIRE-AND-FORGET. Callers `void` this. A governance alert must never slow, fail, or alter a
 * customer reply — the same posture as `upsertPromptBlob` on the same code path.
 */
import { createAIAlert } from '../db/models/aiAlert';
import { redisConnection } from '../jobs/redisConnection';
import { socketService } from './socketService';
import { LOCKED_CATALOG_MARKER_KEY } from './promptRegistryReconcile';

export const PROMPT_ASSEMBLY_ALERT_REASON = 'prompt_assembly_violation';

/** Long enough that it never expires inside one catalog epoch; short enough not to leak keys. */
const DEDUPE_TTL_SECONDS = 7 * 24 * 60 * 60;

export type PromptAssemblyIssueKind =
  | 'orphan_block_key'
  | 'missing_required_section'
  | 'forbidden_section_reference'
  | 'over_budget'
  | 'unknown_placeholder_token';

export interface PromptAssemblyIssue {
  kind: PromptAssemblyIssueKind;
  /** The specific thing at fault — a block key, a section name, an "N > M" pair, a token. */
  detail: string;
}

/**
 * Dedup identity for an issue's detail. For every kind except `over_budget` the detail IS the
 * identity (a block key, a section name, a token — stable while the condition persists). But
 * `over_budget`'s detail is `"N > M"` where N is the assembled prompt's length, which varies on
 * every reply — keying on it mints a fresh dedupe key per turn and quietly reduces the whole
 * design back to one alert per reply. The stable identity of an over-budget condition is the
 * budget cap M: key on that, keep the precise `"N > M"` in the alert row's details. A no-match
 * detail degrades to a constant — the safe direction (fewer alerts, never one per reply).
 */
export function dedupeDetailFor(issue: PromptAssemblyIssue): string {
  if (issue.kind !== 'over_budget') return issue.detail;
  const capMatch = issue.detail.match(/>\s*(\d+)\s*$/);
  return capMatch ? `cap:${capMatch[1]}` : 'cap:unknown';
}

/**
 * Pure — the whole point of factoring it out. `marker` is the locked-catalog fingerprint, or
 * `'nomarker'` when the registry has not published one yet (Redis cold, or the flag is off): a
 * missing marker must degrade to "dedupe within a constant epoch", never to "no dedupe at all",
 * because the no-dedupe branch is one alert per reply.
 */
export function assemblyAlertDedupeKey(
  tenantId: string,
  issue: PromptAssemblyIssue,
  marker: string | null,
): string {
  return `prompt_assembly_alert:${tenantId}:${issue.kind}:${dedupeDetailFor(issue)}:${marker ?? 'nomarker'}`;
}

/**
 * Map what the assembly reported into the issues worth alerting on.
 *
 * Deliberately NOT everything the assembly reports. A `budget` drop is the budget doing its job
 * — configured behaviour, already recorded in ledger provenance, and not a governance failure.
 * `disabled` and `vision_absent` are normal. What is alertable is content that should not exist
 * (an orphan key), a required section that failed to render, a phantom section reference, an
 * over-budget prompt, and a placeholder nobody defined.
 */
export function collectPromptAssemblyIssues(input: {
  droppedBlocks: Array<{ key: string; reason: string }>;
  violations: Array<{ kind: string; detail: string }>;
  unknownTokens: string[];
}): PromptAssemblyIssue[] {
  const issues: PromptAssemblyIssue[] = [];

  for (const dropped of input.droppedBlocks) {
    if (dropped.reason === 'allowlist') {
      issues.push({ kind: 'orphan_block_key', detail: dropped.key });
    }
  }
  for (const violation of input.violations) {
    if (
      violation.kind === 'missing_required_section' ||
      violation.kind === 'forbidden_section_reference' ||
      violation.kind === 'over_budget'
    ) {
      issues.push({ kind: violation.kind, detail: violation.detail });
    }
  }
  for (const token of new Set(input.unknownTokens)) {
    issues.push({ kind: 'unknown_placeholder_token', detail: token });
  }

  return issues;
}

/**
 * Raise one alert per (tenant, issue, catalog epoch). Swallows everything.
 *
 * The alert is SYSTEM-scoped (`conversation_id: null`) on purpose: a misassembled prompt is a
 * configuration fault affecting every conversation, not an escalation of the one that happened to
 * observe it. That also keeps it out of the Orders action tab, which filters on a non-null
 * conversation — correct for a config problem. Follows `refreshMetaTokens` / `channelIsolationService`.
 */
export async function raisePromptAssemblyAlerts(
  tenantId: string,
  issues: PromptAssemblyIssue[],
): Promise<void> {
  if (issues.length === 0) return;

  let marker: string | null = null;
  try {
    marker = await redisConnection.get(LOCKED_CATALOG_MARKER_KEY);
  } catch {
    // Redis unavailable — fall through with a null marker. Alerting degrades to the constant
    // epoch, which is the safe direction (fewer alerts, not one per reply).
  }

  for (const issue of issues) {
    try {
      const key = assemblyAlertDedupeKey(tenantId, issue, marker);
      const claimed = await redisConnection.set(key, '1', 'EX', DEDUPE_TTL_SECONDS, 'NX');
      if (claimed !== 'OK') continue;

      const alert = await createAIAlert({
        tenant_id: tenantId,
        conversation_id: null,
        message_id: null,
        reason: PROMPT_ASSEMBLY_ALERT_REASON,
        details: { kind: issue.kind, detail: issue.detail, catalog_marker: marker },
      });

      // `channel_type: 'facebook'` is not a claim about a channel — a prompt-assembly fault has
      // none. It matches what the REST read path returns for this very row: the alert list query
      // does `COALESCE(ch.type, 'facebook')` over a LEFT JOIN that finds nothing when
      // `conversation_id` is NULL. The frontend patches its query cache from these socket events,
      // so the socket payload and the fetched row must describe the row the same way; inventing a
      // different placeholder here would make the same alert render two ways.
      socketService.emitAIAlert(tenantId, {
        ...alert,
        message_content: null,
        contact_name: 'System',
        channel_type: 'facebook',
        channel_name: '—',
      });
    } catch (err) {
      console.warn('[promptAssembly] Alert emit failed', {
        tenantId,
        kind: issue.kind,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
