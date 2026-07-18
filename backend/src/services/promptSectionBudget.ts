/**
 * P3-5 (RC-26): a whole-prompt char budget that truncates by DECLARED priority.
 *
 * WHAT WAS MISSING. P2-5 gave the guideline blocks a truncating budget and the full prompt a
 * REPORTING threshold — so RC-26's actual finding ("the system prompt is 26-33K chars and
 * unbudgeted, while only history is capped at 6000 tokens") was measured but never enforced. This
 * module is the enforcement, and the item's wording is the specification: over-budget sections are
 * "truncated by declared priority, not silently".
 *
 * WHAT MAY NOT BE CUT, and why the catalog is the important one.
 *
 * Truncating the injected product catalog would reintroduce RC-02 through the back door. The
 * grounding guards validate a reply against the FULL ACTIVE CATALOG (P0-2's
 * GUARD_VALIDATE_AGAINST_FULL_CATALOG, P2-1's consolidated gate) — never against what the prompt
 * happened to contain. So a product trimmed out of the prompt to save chars does not become
 * invisible: it becomes a product the model cannot see but the guard still accepts, and the model
 * answers "we do not carry that" about an item that is in stock. The reply is wrong AND passes
 * every check. That is strictly worse than an over-budget prompt.
 *
 * Also protected: the restrictions footer and platform policy (dropping the business rules to save
 * space inverts the priority ladder the prompt itself declares), the grounding directive (dropping
 * it while the facts_used contract is active makes the completion unparseable and every reply a
 * retry), and the persona/profile/guidelines core.
 *
 * WHAT MAY BE CUT, in declared order — the honest test being "does losing this make the reply
 * WORDIER, or WRONG?". Only the first kind is truncatable.
 *
 * Never throws. An over-budget prompt is a degradation; a prompt missing the language lock or the
 * platform rules is a correctness and policy breach. Same posture as `applyGuidelineBudget`.
 */

/**
 * Drop order is `low` -> `normal` -> `high`; `protected` is never dropped.
 *
 * Four tiers rather than a numeric weight on purpose: a number invites fine-grained tuning of
 * something nobody can measure per-section, and the real decision is coarse — is this section
 * load-bearing, or is it polish?
 */
export type SectionPriority = 'protected' | 'high' | 'normal' | 'low';

export interface PromptSection {
  /** Stable identifier; appears in ledger provenance, so keep it greppable. */
  id: string;
  text: string;
  priority: SectionPriority;
}

export interface SectionAccounting {
  id: string;
  chars: number;
  dropped: boolean;
}

export interface SectionBudgetResult {
  prompt: string;
  /** Every section, in DECLARATION order, with its size and whether it survived. */
  sections: SectionAccounting[];
  /** Dropped section ids in DROP SEQUENCE — lowest priority first, last-declared first in a tier. */
  droppedIds: string[];
  /** Still over budget once everything droppable is gone — only protected sections remain. */
  overBudget: boolean;
  totalChars: number;
}

const DROP_ORDER: SectionPriority[] = ['low', 'normal', 'high'];

/** Sections are joined by simple concatenation: each already carries its own leading separator. */
export function joinSections(sections: ReadonlyArray<PromptSection>): string {
  return sections.map((s) => s.text).join('');
}

/**
 * Apply the budget.
 *
 * Within a tier the LAST-declared section is dropped first, matching `applyGuidelineBudget`'s
 * rule and for the same reason: declaration order runs foundational-first, so the tail is the
 * most situational. Kept sections are emitted in their original order, so the prompt a truncated
 * assembly produces is a subsequence of the one it would otherwise have produced — never a
 * reordering.
 *
 * `maxChars <= 0` or a non-finite budget means "no ceiling" — callers in shadow mode pass
 * Infinity, and that path must be byte-identical to plain concatenation.
 */
export function applySectionBudget(
  sections: ReadonlyArray<PromptSection>,
  maxChars: number,
): SectionBudgetResult {
  const kept = sections.map((s, index) => ({ section: s, index, dropped: false }));
  const unbounded = !Number.isFinite(maxChars) || maxChars <= 0;
  // In DROP SEQUENCE, not declaration order. `sections` below already reports declaration order,
  // so recording the sequence here adds the information that order would only duplicate: it makes
  // the priority contract observable from the outside ("what went first, and was that right?").
  const droppedIds: string[] = [];

  const total = (): number =>
    kept.reduce((sum, k) => (k.dropped ? sum : sum + k.section.text.length), 0);

  if (!unbounded) {
    for (const tier of DROP_ORDER) {
      if (total() <= maxChars) break;
      for (let i = kept.length - 1; i >= 0; i--) {
        if (total() <= maxChars) break;
        const candidate = kept[i];
        if (candidate.dropped || candidate.section.priority !== tier) continue;
        candidate.dropped = true;
        droppedIds.push(candidate.section.id);
      }
    }
  }

  const survivors = kept.filter((k) => !k.dropped);
  const totalChars = survivors.reduce((sum, k) => sum + k.section.text.length, 0);

  return {
    prompt: survivors.map((k) => k.section.text).join(''),
    sections: kept.map((k) => ({
      id: k.section.id,
      chars: k.section.text.length,
      dropped: k.dropped,
    })),
    droppedIds,
    overBudget: !unbounded && totalChars > maxChars,
    totalChars,
  };
}
