/**
 * P2-2 (migration-path step 1) — Shared structured-output contract helper.
 *
 * Generalizes P2-1's single-purpose `parseFactsUsedCompletion` (`groundingGate.ts`) into a
 * reusable parser so any classifier can move from a free-form `response_format:{type:'json_object'}`
 * + ad-hoc `JSON.parse` to a strict `response_format:{type:'json_schema'}` validated against a Zod
 * schema. The parse has ONE explicit fail policy: a truncated (`finish_reason:'length'`),
 * unparseable, or shape-violating completion throws a RETRYABLE `StructuredContractError` — the
 * same posture as `GenerationContractError`, so a malformed structured output rides the BullMQ
 * retry path instead of being silently coerced to a default (the fail-open pattern the audit's
 * RC-22/I8 flags). Callers that must stay fail-open under a flag keep their legacy parser on the
 * flag-off branch.
 *
 * Pure and network-free: it takes the already-fetched completion `content` + `finish_reason`, so
 * it is fully unit-testable in-process (mirrors `groundingGate`/`classifierConfidenceContract`).
 */
import { z, type ZodType } from 'zod';
import {
  confidenceContractSchema,
  normalizeClassifierConfidence,
} from './classifierConfidenceContract';

/**
 * Retryable failure of a structured-output contract — a truncated, unparseable, or
 * schema-violating completion. Mirrors `GenerationContractError` (`groundingGate.ts`) so both the
 * generation and the classifier paths surface malformed structured output the same way.
 */
export class StructuredContractError extends Error {
  readonly kind: 'truncated' | 'parse' | 'shape';
  readonly detector?: string;
  constructor(message: string, kind: 'truncated' | 'parse' | 'shape', detector?: string) {
    super(message);
    this.name = 'StructuredContractError';
    this.kind = kind;
    this.detector = detector;
  }
}

/** The `response_format` value for a strict `json_schema` classifier call. */
export interface JsonSchemaResponseFormat {
  type: 'json_schema';
  json_schema: { name: string; strict: true; schema: Record<string, unknown> };
}

/**
 * Wrap a hand-authored JSON-Schema object into the `response_format` shape OpenAI's strict mode
 * expects — the same `{ name, strict, schema }` form P2-1's `FACTS_USED_JSON_SCHEMA` uses. We keep
 * schemas hand-authored (no `zod-to-json-schema` dependency) to match the house style; the Zod
 * schema handed to {@link parseStructuredCompletion} is the runtime validator of the parsed result.
 */
export function buildJsonSchema(name: string, schema: Record<string, unknown>): JsonSchemaResponseFormat {
  return { type: 'json_schema', json_schema: { name, strict: true, schema } };
}

/**
 * Parse + validate a structured completion into `T`. Throws `StructuredContractError` (retryable)
 * on truncation (`finishReason === 'length'`, classified BEFORE the necessarily-invalid JSON
 * parse), invalid JSON, or a payload the Zod `schema` rejects. On success returns the validated,
 * typed payload.
 */
export function parseStructuredCompletion<T>(
  content: string | null | undefined,
  opts: { schema: ZodType<T>; finishReason?: string | null; detector?: string },
): T {
  const { schema, finishReason, detector } = opts;
  if (finishReason === 'length') {
    throw new StructuredContractError('structured completion truncated at max_tokens', 'truncated', detector);
  }
  const raw = (content ?? '').trim();
  if (!raw) throw new StructuredContractError('empty structured completion', 'parse', detector);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StructuredContractError('structured completion is not valid JSON', 'parse', detector);
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new StructuredContractError(
      `structured completion failed schema validation: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      'shape',
      detector,
    );
  }
  return result.data;
}

/**
 * The shared required-`confidence` Zod fragment: a number in `[0, 100]` (values in `(1, 100]` are
 * the C-63 percentage scale, normalized by {@link normalizeClassifierConfidence} to `[0, 1]`
 * downstream). Compose it into a classifier's schema so `confidence` is a mandatory, range-checked
 * field — the P1-3 confidence contract, now enforced at the parse boundary. Re-exports the single
 * normalization so every adopter shares one interpretation of the scale-guess.
 */
export const confidenceField = confidenceContractSchema.shape.confidence;
export { normalizeClassifierConfidence };
export { z };
