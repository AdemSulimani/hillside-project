/**
 * P2-7 — the single model-resolution chain (M8) and the role taxonomy (M5).
 *
 * The point of these tests is BEHAVIOUR PRESERVATION. P2-7 collapsed four competing resolution
 * idioms into one resolver across ~30 call sites; the risk of that refactor is not that it fails
 * loudly, it is that it quietly moves a model — and therefore the cost, latency and wording of real
 * customer replies — in some environment nobody tested. So each role's chain is pinned here,
 * including the two cases where the "obvious" mapping would have been wrong (product_processing's
 * mini terminal, and vision's M1 custom_model_id drop).
 *
 * `resolveModel` takes `env` as a parameter, so none of this touches process.env.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMBEDDING_COLUMN_TABLES,
  EMBEDDING_MODEL_DIMS,
  EXPECTED_EMBEDDING_DIM,
  MODEL_ROLES,
  type ModelRole,
  modelEnvKeys,
  resolveModel,
} from '../models';

describe('resolveModel — chains', () => {
  it('every chat-family role falls back to OPENAI_CHAT_MODEL', () => {
    // This is what makes the new per-role vars purely additive: an env that sets only
    // OPENAI_CHAT_MODEL (i.e. every existing deployment) behaves exactly as it did before P2-7.
    const env = { OPENAI_CHAT_MODEL: 'gpt-4o-2024-11-20' };
    for (const role of ['classifier', 'vision', 'eval', 'intent', 'product_processing'] as const) {
      assert.equal(resolveModel(role, { env }), 'gpt-4o-2024-11-20', `role ${role} ignored the fallback`);
    }
  });

  it('a role-specific var wins over OPENAI_CHAT_MODEL', () => {
    const env = { OPENAI_CHAT_MODEL: 'gpt-4o', OPENAI_CLASSIFIER_MODEL: 'gpt-4o-mini' };
    assert.equal(resolveModel('classifier', { env }), 'gpt-4o-mini');
    assert.equal(resolveModel('chat', { env }), 'gpt-4o', 'the reply model must not follow it');
    assert.equal(resolveModel('vision', { env }), 'gpt-4o', 'nor any other role');
  });

  it('falls back to the terminal default on an empty env', () => {
    assert.equal(resolveModel('chat', { env: {} }), 'gpt-4o');
    assert.equal(resolveModel('classifier', { env: {} }), 'gpt-4o');
    assert.equal(resolveModel('finetune_base', { env: {} }), 'gpt-4o-mini-2024-07-18');
  });

  it('ignores whitespace-only values rather than resolving to a blank model', () => {
    assert.equal(resolveModel('chat', { env: { OPENAI_CHAT_MODEL: '   ' } }), 'gpt-4o');
    assert.equal(
      resolveModel('classifier', { env: { OPENAI_CLASSIFIER_MODEL: '  ', OPENAI_CHAT_MODEL: 'gpt-4o' } }),
      'gpt-4o',
      'an empty role var must fall through, not win',
    );
  });

  it('trims a set value', () => {
    assert.equal(resolveModel('chat', { env: { OPENAI_CHAT_MODEL: ' gpt-4o ' } }), 'gpt-4o');
  });
});

describe('resolveModel — product_processing keeps its gpt-4o-mini terminal', () => {
  it('resolves to mini when nothing is set — NOT the generic gpt-4o', () => {
    // The trap this pins: AIProductProcessingService has always been
    // `process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini'` — chat model when set, mini when not.
    // Giving this role the generic gpt-4o terminal (as every other chat-family role has) would
    // silently move product extraction to gpt-4o — roughly 15x the cost — in any environment that
    // leaves OPENAI_CHAT_MODEL unset, with nothing failing to reveal it.
    assert.equal(resolveModel('product_processing', { env: {} }), 'gpt-4o-mini');
  });

  it('follows OPENAI_CHAT_MODEL when it is set — the historical behaviour', () => {
    assert.equal(
      resolveModel('product_processing', { env: { OPENAI_CHAT_MODEL: 'gpt-4o' } }),
      'gpt-4o',
    );
  });

  it('reproduces the pre-P2-7 expression exactly across a matrix', () => {
    const legacy = (env: NodeJS.ProcessEnv) => env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';
    for (const env of [{}, { OPENAI_CHAT_MODEL: 'gpt-4o' }, { OPENAI_CHAT_MODEL: 'gpt-4o-2024-11-20' }]) {
      assert.equal(resolveModel('product_processing', { env }), legacy(env), JSON.stringify(env));
    }
  });
});

describe('resolveModel — custom_model_id precedence (M1)', () => {
  const env = { OPENAI_CHAT_MODEL: 'gpt-4o', OPENAI_VISION_MODEL: 'gpt-4o-vision' };

  it('a tenant custom model beats the env chain', () => {
    assert.equal(resolveModel('chat', { env, customModelId: 'ft:gpt-4o:acme:1' }), 'ft:gpt-4o:acme:1');
  });

  it('ignores a null/blank custom model', () => {
    assert.equal(resolveModel('chat', { env, customModelId: null }), 'gpt-4o');
    assert.equal(resolveModel('chat', { env, customModelId: '   ' }), 'gpt-4o');
  });

  it('M1 PIN: the vision path drops custom_model_id — a known defect, preserved deliberately', () => {
    // aiService's vision branch passes no customModelId, so a fine-tuned tenant gets the vision
    // model on image turns and their fine-tune on text turns. That inconsistency IS audit finding
    // M1. P2-7's job was to make the drop explicit rather than an accident of expression shape —
    // NOT to fix it. This test exists so that a future "cleanup" cannot silently change which model
    // serves a fine-tuned tenant's image replies while thinking it is tidying an oversight.
    // If M1 is ever fixed, this test should be updated by that change, on purpose.
    assert.equal(resolveModel('vision', { env, customModelId: null }), 'gpt-4o-vision');
  });
});

describe('resolveModel — embedding has no terminal (the RC-04 landmine)', () => {
  it('resolves to the env value', () => {
    assert.equal(
      resolveModel('embedding', { env: { OPENAI_EMBEDDING_MODEL: 'text-embedding-3-small' } }),
      'text-embedding-3-small',
    );
  });

  it('resolves to empty when unset — deliberately no guess', () => {
    // Pre-P2-7 this fell back to 'text-embedding-3-large' (3072-dim) against a vector(1536)
    // column: every similarity query errors, semantic retrieval silently dies fleet-wide, and the
    // only thing standing between a deployment and that outcome was remembering to set the var.
    // A wrong default is more dangerous than no default — validateEnv fatals on the empty case.
    assert.equal(resolveModel('embedding', { env: {} }), '');
  });

  it('never falls back to OPENAI_CHAT_MODEL', () => {
    assert.equal(resolveModel('embedding', { env: { OPENAI_CHAT_MODEL: 'gpt-4o' } }), '');
  });
});

describe('the dimension table', () => {
  it('knows the 1536-dim models and the 3072-dim trap', () => {
    assert.equal(EMBEDDING_MODEL_DIMS['text-embedding-3-small'], EXPECTED_EMBEDDING_DIM);
    assert.equal(EMBEDDING_MODEL_DIMS['text-embedding-ada-002'], EXPECTED_EMBEDDING_DIM);
    assert.equal(EMBEDDING_MODEL_DIMS['text-embedding-3-large'], 3072);
    assert.notEqual(EMBEDDING_MODEL_DIMS['text-embedding-3-large'], EXPECTED_EMBEDDING_DIM);
  });

  it('lists every table whose embedding column must match', () => {
    // Both are vector(1536); missing one would let a mismatch through on the image path.
    assert.deepEqual([...EMBEDDING_COLUMN_TABLES], ['products', 'product_image_fingerprints']);
  });
});

describe('role taxonomy hygiene', () => {
  it('every role has a non-empty chain', () => {
    for (const [role, spec] of Object.entries(MODEL_ROLES)) {
      assert.ok(spec.chain.length > 0, `${role} has no env chain`);
    }
  });

  it('every chat-family role ends its chain at OPENAI_CHAT_MODEL', () => {
    const chatFamily: ModelRole[] = ['classifier', 'vision', 'eval', 'intent', 'product_processing'];
    for (const role of chatFamily) {
      const chain = MODEL_ROLES[role].chain;
      assert.equal(chain[chain.length - 1], 'OPENAI_CHAT_MODEL', `${role} does not fall back`);
    }
  });

  it('exposes every model env key for the manifest/.env.example check', () => {
    const keys = modelEnvKeys();
    assert.ok(keys.includes('OPENAI_CHAT_MODEL'));
    assert.ok(keys.includes('OPENAI_CLASSIFIER_MODEL'));
    assert.ok(keys.includes('OPENAI_PRODUCT_PROCESSING_MODEL'));
    assert.equal(new Set(keys).size, keys.length, 'no duplicates');
  });
});
