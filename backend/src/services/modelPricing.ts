/**
 * P1-5 (OBS-2 / C-108): per-model token pricing so the AI decision ledger can record the USD
 * cost of a reply — the platform is usage-billed yet has zero COGS visibility today.
 *
 * Pure and side-effect-free. Prices are USD per 1,000,000 tokens. The table is intentionally
 * externalizable (env `OPENAI_MODEL_PRICES`, a JSON map) so a price change is config-only and
 * never a code deploy — the P3-6 edge case "Model price table drift — externalize prices to
 * config". Scope is the main-reply models (chat + vision + fine-tuned overrides); per-classifier
 * cost is a documented follow-up.
 *
 * An unknown model returns `null` cost (recorded as such in the ledger) rather than a wrong
 * number — a missing price is visible, not silently zero.
 */

export interface TokenUsage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
}

export interface ModelPrice {
  /** USD per 1,000,000 prompt (input) tokens. */
  inputPerM: number;
  /** USD per 1,000,000 completion (output) tokens. */
  outputPerM: number;
}

/**
 * Built-in defaults (public OpenAI list prices, USD / 1M tokens). Keyed by the base model id;
 * dated snapshots (`gpt-4o-2024-08-06`) resolve to their family via longest-prefix match.
 * Fine-tuned models are priced separately (OpenAI charges a premium on ft:* inference).
 */
const DEFAULT_PRICES: Record<string, ModelPrice> = {
  'gpt-4o-mini': { inputPerM: 0.15, outputPerM: 0.6 },
  'gpt-4o': { inputPerM: 2.5, outputPerM: 10 },
  'gpt-4.1-mini': { inputPerM: 0.4, outputPerM: 1.6 },
  'gpt-4.1': { inputPerM: 2, outputPerM: 8 },
  // Fine-tuned inference premium (base family, ft:* prefix stripped before lookup).
  'ft:gpt-4o-mini': { inputPerM: 0.3, outputPerM: 1.2 },
  'ft:gpt-4o': { inputPerM: 3.75, outputPerM: 15 },
};

/** Parse the optional env override once at module load. Malformed JSON is ignored (fail-open). */
function loadPriceOverrides(): Record<string, ModelPrice> {
  const raw = process.env.OPENAI_MODEL_PRICES?.trim();
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
        out[model] = { inputPerM: price.inputPerM, outputPerM: price.outputPerM };
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

/**
 * Compute the USD cost of one call from its model and token usage. Returns `null` (unknown/
 * uncomputable) when the model is unpriced or usage is missing — never a fabricated 0. Rounded
 * to 6 decimals (micro-dollars), enough for per-reply COGS aggregation.
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
  const cost = (input / 1_000_000) * price.inputPerM + (output / 1_000_000) * price.outputPerM;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
