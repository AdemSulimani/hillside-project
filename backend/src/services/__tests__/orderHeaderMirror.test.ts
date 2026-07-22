/**
 * Source-level invariants for the multi-product order header mirror (migration 088 audit fixes).
 *
 * `db/models/order.ts` is raw SQL against the pool and `processAIReply.ts` reaches openaiClient's
 * boot-fatal env reads, so — following the house convention (`evalIsolation.test.ts`,
 * `replyPathSourceInvariants.test.ts`) — these regressions are pinned as assertions over the
 * source text, each with an anchor guard so a refactor cannot make an assertion pass vacuously.
 *
 * Invariants:
 *  1. F2 (commission desync): `recomputeOrderHeaderFromItems` — the SOLE post-creation writer of
 *     the header mirror — re-derives `commission_amount` as 5% of the summed line total for
 *     commissionable orders. Without this, a draft quantity edit recomputes quantity/total but
 *     leaves the stored commission stale against the header total.
 *  2. Mirror maintenance: `updateDraftOrderForTenant` still routes every line edit through
 *     `recomputeOrderHeaderFromItems` (the sole-writer contract).
 *  3. F1 (cached-verdict crash): the order tail re-normalizes the purchase_intent verdict through
 *     `mapIntentPayload`. `classifierVerdictStore` returns cached hits as JSON.parse verbatim, so
 *     a verdict cached before the items[] deploy has no `items` key — without the re-map,
 *     `intent.items.length` throws and the order is silently not created
 *     (order_detection_failed).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

function findSrcDir(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'src');
    if (existsSync(path.join(candidate, 'services', 'aiService.ts'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate backend/src from cwd ${process.cwd()}`);
}

const SRC = findSrcDir();
const orderModelSource = readFileSync(path.join(SRC, 'db', 'models', 'order.ts'), 'utf8');
const processAIReplySource = readFileSync(path.join(SRC, 'jobs', 'processAIReply.ts'), 'utf8');

describe('F2: recomputeOrderHeaderFromItems keeps commission_amount synced to the summed total', () => {
  const fnStart = orderModelSource.indexOf('export async function recomputeOrderHeaderFromItems');
  const fnEnd = orderModelSource.indexOf('export ', fnStart + 1);
  const fnBody = orderModelSource.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);

  it('the recompute function still exists (anchor guard)', () => {
    assert.ok(fnStart !== -1, 'recomputeOrderHeaderFromItems not found in db/models/order.ts');
  });

  it('re-derives commission_amount at 5% of the summed total for commissionable orders only', () => {
    assert.ok(
      fnBody.includes('commission_amount = CASE'),
      'recompute SQL no longer writes commission_amount — a draft quantity edit desyncs the stored commission from the header total',
    );
    assert.ok(
      fnBody.includes('WHEN o.is_commissionable THEN ROUND((SELECT t_sum FROM agg) * 0.05, 2)'),
      'commissionable orders must get commission_amount = ROUND(summed_total * 0.05, 2)',
    );
    assert.ok(
      fnBody.includes('ELSE o.commission_amount'),
      'non-commissionable orders must keep their commission_amount untouched (NULL stays NULL)',
    );
  });

  it('updateDraftOrderForTenant still routes line edits through the sole mirror writer', () => {
    const updStart = orderModelSource.indexOf('export async function updateDraftOrderForTenant');
    assert.ok(updStart !== -1, 'updateDraftOrderForTenant not found');
    const updEnd = orderModelSource.indexOf('export ', updStart + 1);
    const updBody = orderModelSource.slice(updStart, updEnd === -1 ? undefined : updEnd);
    assert.ok(
      updBody.includes('recomputeOrderHeaderFromItems('),
      'updateDraftOrderForTenant must recompute the header mirror after a line edit',
    );
  });
});

describe('F1: the order tail re-normalizes the purchase_intent verdict through mapIntentPayload', () => {
  it('the purchase_intent verdict read still exists (anchor guard)', () => {
    assert.ok(
      processAIReplySource.includes(`detector: 'purchase_intent',`),
      'purchase_intent verdict read not found in processAIReply.ts',
    );
  });

  it('the verdict result is passed through mapIntentPayload before items[] is read', () => {
    // The re-map must sit between the verdict read and the tail's `intent.items` access —
    // pinned as: the tail assigns `intent` from mapIntentPayload, not directly from the store.
    assert.ok(
      processAIReplySource.includes('const intent = mapIntentPayload('),
      'the tail no longer re-maps the cached/computed verdict — a pre-items[] cached blob will crash intent.items.length and silently drop the order',
    );
    assert.ok(
      processAIReplySource.includes("import { mapIntentPayload } from '../services/intentPayload'"),
      'mapIntentPayload import missing from processAIReply.ts',
    );
  });
});
