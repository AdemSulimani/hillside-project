/**
 * Tests for the shared structured-output contract helper (P2-2, Slice A).
 *
 * The helper generalizes P2-1's `parseFactsUsedCompletion` into `parseStructuredCompletion`: it
 * validates a completion against a Zod schema with ONE explicit fail policy — a truncated,
 * unparseable, or shape-violating payload throws a retryable `StructuredContractError` (never a
 * silent coercion). These tests exercise it purely in-process (no network/OpenAI).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  StructuredContractError,
  buildJsonSchema,
  parseStructuredCompletion,
  confidenceField,
  normalizeClassifierConfidence,
  z,
} from '../structuredClassifier';

const sampleSchema = z
  .object({
    is_thing: z.boolean(),
    confidence: confidenceField,
  })
  .passthrough();

describe('buildJsonSchema', () => {
  it('wraps a hand-authored schema into the strict json_schema response_format shape', () => {
    const rf = buildJsonSchema('my_classifier', { type: 'object', properties: {} });
    assert.equal(rf.type, 'json_schema');
    assert.equal(rf.json_schema.name, 'my_classifier');
    assert.equal(rf.json_schema.strict, true);
    assert.deepEqual(rf.json_schema.schema, { type: 'object', properties: {} });
  });
});

describe('parseStructuredCompletion', () => {
  it('returns the validated, typed payload on a well-formed completion', () => {
    const out = parseStructuredCompletion('{"is_thing": true, "confidence": 90}', {
      schema: sampleSchema,
      finishReason: 'stop',
      detector: 't',
    });
    assert.equal(out.is_thing, true);
    assert.equal(out.confidence, 90);
  });

  it('throws truncated (before parsing) when finish_reason is length', () => {
    assert.throws(
      () =>
        parseStructuredCompletion('{"is_thing": tru', {
          schema: sampleSchema,
          finishReason: 'length',
        }),
      (err: unknown) => err instanceof StructuredContractError && err.kind === 'truncated',
    );
  });

  it('throws parse on empty content', () => {
    assert.throws(
      () => parseStructuredCompletion('   ', { schema: sampleSchema }),
      (err: unknown) => err instanceof StructuredContractError && err.kind === 'parse',
    );
  });

  it('throws parse on invalid JSON', () => {
    assert.throws(
      () => parseStructuredCompletion('{not json', { schema: sampleSchema }),
      (err: unknown) => err instanceof StructuredContractError && err.kind === 'parse',
    );
  });

  it('throws shape when the payload violates the schema (missing required field)', () => {
    assert.throws(
      () => parseStructuredCompletion('{"is_thing": true}', { schema: sampleSchema, detector: 'd' }),
      (err: unknown) =>
        err instanceof StructuredContractError && err.kind === 'shape' && err.detector === 'd',
    );
  });

  it('throws shape when confidence is out of the [0,100] range', () => {
    assert.throws(
      () => parseStructuredCompletion('{"is_thing": true, "confidence": 250}', { schema: sampleSchema }),
      (err: unknown) => err instanceof StructuredContractError && err.kind === 'shape',
    );
  });
});

describe('normalizeClassifierConfidence (shared scale-guess)', () => {
  it('passes 0..1 through and divides the >1 percentage scale by 100', () => {
    assert.equal(normalizeClassifierConfidence(0.85), 0.85);
    assert.equal(normalizeClassifierConfidence(90), 0.9);
    assert.equal(normalizeClassifierConfidence('42'), 0.42);
    assert.equal(normalizeClassifierConfidence('nope'), 0);
    assert.equal(normalizeClassifierConfidence(5), 0.05);
  });
});
