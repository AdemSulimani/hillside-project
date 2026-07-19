/**
 * P1-5 (OBS-2 / C-108): per-model token pricing so the AI decision ledger can record the USD
 * cost of a reply — the platform is usage-billed yet has zero COGS visibility today.
 *
 * Pure and side-effect-free. Prices are USD per 1,000,000 tokens. The table is intentionally
 * externalizable (env `OPENAI_MODEL_PRICES`, a JSON map) so a price change is config-only and
 * never a code deploy — the P3-6 edge case "Model price table drift — externalize prices to
 * config".
 *
 * An unknown model returns `null` cost (recorded as such in the ledger) rather than a wrong
 * number — a missing price is visible, not silently zero.
 *
 * P3-6 adds three things:
 *   1. EMBEDDING PRICES. Every retrieval embedding recorded `usd_cost: null` because the table
 *      held only chat models — one unpriced call per reply, invisible in the COGS total. They are
 *      input-only (an embedding has no completion), which the `outputPerM: 0` entries express.
 *   2. CACHED-INPUT PRICING. OpenAI discounts prompt tokens served from its automatic prefix cache
 *      and reports them as `usage.prompt_tokens_details.cached_tokens`. Measured on live ledger
 *      rows, 21 of 143 calls carry a >=1024-token (i.e. cacheable) prefix and account for 69% of
 *      all spend, so ignoring the discount overstates COGS on exactly the calls that dominate it.
 *      NOTE the seam this creates: once cached rates apply, a `usd_cost` computed after this change
 *      is not directly comparable to one computed before it. `ai_cost_daily.computed_at` is what
 *      makes the discontinuity locatable rather than mysterious.
 *   3. THE ENV OVERRIDE IS NOW A DECLARED KNOB. It used to be a bare `process.env` read, so
 *      `config:check`, `.env.example` drift detection and the config fingerprint were all blind to
 *      it — two instances with different price tables would report divergent COGS for identical
 *      traffic with no drift signal. That is the precise defect class `config/knobs.ts` exists to
 *      remove. `knobs.ts` is a leaf (only `node:crypto` + `./models`), so importing it here keeps
 *      this module importable from `openaiClient`'s graph and from a key-less unit test.
 */
import { knobString } from '../config/knobs';

export interface TokenUsage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  /**
   * Prompt tokens served from OpenAI's automatic prefix cache. A SUBSET of `prompt_tokens`, not an
   * addition to it — the discount applies by re-pricing part of the input, never by adding a term.
   */
  cached_tokens?: number | null;
}

export interface ModelPrice {
  /** USD per 1,000,000 prompt (input) tokens. */
  inputPerM: number;
  /** USD per 1,000,000 completion (output) tokens. */
  outputPerM: number;
  /**
   * USD per 1,000,000 prompt tokens served from cache.
   *
   * Omitted ⇒ **no discount** (`inputPerM`), deliberately. Half-price is the published gpt-4o-family
   * ratio and the built-in entries below state it explicitly, but assuming it for an entry that did
   * not say so would UNDERSTATE cost for an operator-supplied override — and understating COGS is
   * the failure direction that reads as good news. An unknown discount is priced as no discount.
   */
  cachedInputPerM?: number;
}

/**
 * Built-in defaults (public OpenAI list prices, USD / 1M tokens). Keyed by the base model id;
 * dated snapshots (`gpt-4o-2024-08-06`) resolve to their family via longest-prefix match.
 * Fine-tuned models are priced separately (OpenAI charges a premium on ft:* inference).
 */
const DEFAULT_PRICES: Record<string, ModelPrice> = {
  'gpt-4o-mini': { inputPerM: 0.15, outputPerM: 0.6, cachedInputPerM: 0.075 },
  'gpt-4o': { inputPerM: 2.5, outputPerM: 10, cachedInputPerM: 1.25 },
  'gpt-4.1-mini': { inputPerM: 0.4, outputPerM: 1.6, cachedInputPerM: 0.1 },
  'gpt-4.1': { inputPerM: 2, outputPerM: 8, cachedInputPerM: 0.5 },
  // Fine-tuned inference premium (base family, ft:* prefix stripped before lookup).
  'ft:gpt-4o-mini': { inputPerM: 0.3, outputPerM: 1.2, cachedInputPerM: 0.15 },
  'ft:gpt-4o': { inputPerM: 3.75, outputPerM: 15, cachedInputPerM: 1.875 },
  /**
   * Embeddings: input-only. `outputPerM: 0` is a real price here, not a missing one — an embedding
   * response has no completion tokens, so the term is genuinely zero rather than unknown.
   * `text-embedding-3-small` is the deployed model (1536-dim, matching the vector columns).
   */
  'text-embedding-3-small': { inputPerM: 0.02, outputPerM: 0, cachedInputPerM: 0.02 },
  'text-embedding-3-large': { inputPerM: 0.13, outputPerM: 0, cachedInputPerM: 0.13 },
  'text-embedding-ada-002': { inputPerM: 0.1, outputPerM: 0, cachedInputPerM: 0.1 },
};

/** Parse the optional env override once at module load. Malformed JSON is ignored (fail-open). */
function loadPriceOverrides(): Record<string, ModelPrice> {
  const raw = knobString('OPENAI_MODEL_PRICES').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<ModelPrice>>;
    const out: Record<string, ModelPrice> = {};
    for (const [model, price] of Object.entries(parsed)) {
      if (
        price &&
        typeof price.inputPerM === 'number' &&
        typeof price.outputPerM === 'number'
      ) {
        out[model] = {
          inputPerM: price.inputPerM,
          outputPerM: price.outputPerM,
          // Optional in an override too — omitted means "use the default half-price ratio",
          // matching the built-in table's contract rather than silently disabling the discount.
          ...(typeof price.cachedInputPerM === 'number'
            ? { cachedInputPerM: price.cachedInputPerM }
            : {}),
        };
      }
    }
    return out;
  } catch {
    console.warn('[modelPricing] OPENAI_MODEL_PRICES is not valid JSON — ignoring overrides');
    return {};
  }
}

const PRICES: Record<string, ModelPrice> = { ...DEFAULT_PRICES, ...loadPriceOverrides() };

/**
 * A fine-tuned model id looks like `ft:gpt-4o-2024-08-06:my-org::abc123`. Keep the `ft:` prefix
 * and the base family (`ft:gpt-4o-2024-08-06`) for lookup, dropping the org/id suffix so the
 * longest-prefix match can hit the `ft:gpt-4o` / `ft:gpt-4o-mini` entries.
 */
function lookupKey(model: string): string {
  const m = model.trim();
  if (m.startsWith('ft:')) {
    const parts = m.split(':');
    // parts[0]='ft', parts[1]=base family; ignore org (parts[2]) and id.
    return parts[1] ? `ft:${parts[1]}` : m;
  }
  return m;
}

/** Resolve a model's price by exact key then longest-prefix match; `null` if unknown. */
export function resolveModelPrice(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  const key = lookupKey(model);
  if (PRICES[key]) return PRICES[key];
  // Longest-prefix match: 'gpt-4o-2024-08-06' -> 'gpt-4o'; 'ft:gpt-4o-mini-...' -> 'ft:gpt-4o-mini'.
  let best: { len: number; price: ModelPrice } | null = null;
  for (const [prefix, price] of Object.entries(PRICES)) {
    if (key.startsWith(prefix) && (!best || prefix.length > best.len)) {
      best = { len: prefix.length, price };
    }
  }
  return best?.price ?? null;
}

/** The cached-token rate for a price entry: explicit when set, else the undiscounted input rate. */
export function cachedInputRate(price: ModelPrice): number {
  return price.cachedInputPerM ?? price.inputPerM;
}

/**
 * Compute the USD cost of one call from its model and token usage. Returns `null` (unknown/
 * uncomputable) when the model is unpriced or usage is missing — never a fabricated 0. Rounded
 * to 6 decimals (micro-dollars), enough for per-reply COGS aggregation.
 *
 * `cached_tokens` is a SUBSET of `prompt_tokens`, so it is re-priced, not added: the uncached
 * remainder pays `inputPerM` and the cached part pays the discounted rate. Clamped to
 * `[0, prompt_tokens]` — a provider reporting more cached than prompt tokens is nonsense, and
 * letting it through would produce a NEGATIVE uncached term and silently understate COGS, which
 * is the failure direction that looks like good news.
 */
export function computeCost(
  model: string | null | undefined,
  usage: TokenUsage | null | undefined,
): number | null {
  const price = resolveModelPrice(model);
  if (!price || !usage) return null;
  const input = usage.prompt_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;

  const rawCached = usage.cached_tokens ?? 0;
  const cached = Number.isFinite(rawCached) ? Math.min(Math.max(rawCached, 0), input) : 0;
  const uncached = input - cached;

  const cost =
    (uncached / 1_000_000) * price.inputPerM +
    (cached / 1_000_000) * cachedInputRate(price) +
    (output / 1_000_000) * price.outputPerM;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
