/**
 * P3-2 Step 11 (RC-05) — who is responsible for creating the `ai.reply` job?
 *
 * The legacy debounce is the RC-05 mechanism verbatim:
 *
 *     const pending = await aiQueue.getJobs(['delayed', 'waiting']);
 *     const existing = pending.find((j) => j.data?.conversationId === conversation.id);
 *     if (existing) await existing.remove();
 *     await aiQueue.add('ai.reply', …, { delay: 8000 });
 *
 * Three defects in four lines: it does not scan `'active'` (so a job that already started is
 * invisible and a second reply is produced), it removes at most ONE match, and the whole read-then-
 * remove-then-add sequence is not atomic — whether two rapid messages become one merged reply, two
 * replies, or one reply plus a silent stale-skip is decided by sub-second arrival timing rather than
 * content. It is also O(queue depth) per inbound message, on the same `ai` queue the fairness gate
 * re-adds into.
 *
 * P1-1 already shipped the structural replacement: `upsertLiveAiReplyTx` writes the intent with
 * `ON CONFLICT (conversation_id) WHERE topic='ai.reply' AND status='pending' DO UPDATE`, backed by
 * a partial unique index. Single-live-intent-per-conversation becomes a database invariant instead
 * of a best-effort scan, and the debounce window rides on `available_at` inside the same transaction
 * as the message insert.
 *
 * This module isolates the resulting 2×2 so the states are pinned by a test rather than by reading
 * two `&&`s in a 1300-line file. The dangerous cell is not the one that double-enqueues — it is any
 * cell where NEITHER path enqueues, which is total customer silence.
 */

export interface InboundEnqueueFlags {
  /** `INBOUND_OUTBOX_ENQUEUE` — write the ai.reply intent transactionally with the message row. */
  outboxEnqueue: boolean;
  /** `OUTBOX_DISPATCH_ENABLED` — the relay actually turns intents into jobs (vs shadow-draining). */
  outboxDispatch: boolean;
}

export interface InboundEnqueuePlan {
  /** Write the transactional outbox intent. */
  writeOutboxIntent: boolean;
  /** Run the legacy getJobs/remove/add debounce. */
  legacyDirectEnqueue: boolean;
  /** Which mechanism is responsible for the job existing — for logs and assertions. */
  owner: 'legacy' | 'outbox';
}

/**
 * The full 2×2.
 *
 * | outboxEnqueue | outboxDispatch | intent | legacy add | owner  |
 * |---------------|----------------|--------|-----------|--------|
 * | false         | false          |   no   |    yes    | legacy |
 * | false         | true           |   no   |    yes    | legacy |
 * | true          | false          |  yes   |    yes    | legacy |  ← shadow: relay drains without dispatching
 * | true          | true           |  yes   |    no     | outbox |
 *
 * The two half-on rows keep the legacy enqueue on purpose. Writing the intent while the relay is
 * only shadow-draining, and dropping the direct add on that basis, would produce a state where the
 * intent is marked done without ever becoming a job — a stored customer message that is never
 * answered and leaves no error artifact. That is RC-21's failure mode, and it is strictly worse
 * than the duplicate this ordering avoids.
 */
export function planInboundEnqueue(flags: InboundEnqueueFlags): InboundEnqueuePlan {
  const outboxOwnsDelivery = flags.outboxEnqueue && flags.outboxDispatch;
  return {
    writeOutboxIntent: flags.outboxEnqueue,
    legacyDirectEnqueue: !outboxOwnsDelivery,
    owner: outboxOwnsDelivery ? 'outbox' : 'legacy',
  };
}

/**
 * Exactly one mechanism must be responsible in every configuration.
 *
 * Kept as its own predicate so the property can be asserted across the whole flag space rather than
 * case by case — "some combination of two booleans silently answers nobody" is precisely the kind of
 * bug that survives example-by-example testing.
 */
export function hasExactlyOneEnqueueOwner(plan: InboundEnqueuePlan): boolean {
  const outboxDelivers = plan.owner === 'outbox' && plan.writeOutboxIntent;
  const legacyDelivers = plan.legacyDirectEnqueue;
  return outboxDelivers !== legacyDelivers;
}
