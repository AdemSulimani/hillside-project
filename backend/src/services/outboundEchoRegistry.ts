import { redisConnection } from '../jobs/redisConnection';

/**
 * Registry of message ids our platform sent through the Meta Send API (AI auto-replies and
 * auto-sent product images).
 *
 * Why this exists:
 *   Meta echoes EVERY message a Page sends back to us as an inbound webhook event. On
 *   Facebook Messenger those echoes carry an `app_id` we can use to tell an API/automated
 *   send apart from a human agent typing in Meta's native tools. On INSTAGRAM the echo
 *   carries NO `app_id`, so the inbound handler cannot use that signal — it otherwise falls
 *   back to matching the echo's `mid` against the outbound row we persisted at send time.
 *
 *   That fallback breaks when the outbound row isn't persisted yet: the AI reply job persists
 *   its text row only AFTER it finishes sending, and it does not persist auto-sent product
 *   images at all. When an image reply is involved, the platform's echo frequently arrives and
 *   is processed BEFORE our row exists, so the echo is misread as a human-agent reply — which
 *   wrongly puts the conversation on human hold and races the AI job into a duplicate-key error.
 *
 *   We therefore record each id the moment the Send API returns it — synchronously, before Meta
 *   can echo it back — so the inbound handler can always recognise our own echoes regardless of
 *   DB persistence timing.
 */

// Meta echoes arrive within seconds; a few minutes is a safe upper bound that also matches the
// inbound handler's content-based echo dedup window.
export const SELF_ECHO_TTL_SECONDS = 10 * 60;

export function selfEchoKey(externalMessageId: string): string {
  return `self_send_echo:${externalMessageId}`;
}

/**
 * The minimal Redis surface the registry uses. Injectable (defaulting to the shared
 * connection) so unit tests can stub the three outcomes — hit, miss, throw — without a
 * live Redis, and the integration suite can run against its own client.
 */
export interface SelfEchoRedisClient {
  set(key: string, value: string, expiryMode: 'EX', ttlSeconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

/** Record a message id our Send API call just returned, so its later echo is recognised as ours. */
export async function markSelfSentMessageEcho(
  externalMessageId: string | null | undefined,
  client: SelfEchoRedisClient = redisConnection,
): Promise<void> {
  const id = externalMessageId?.trim();
  if (!id) return;
  try {
    await client.set(selfEchoKey(id), '1', 'EX', SELF_ECHO_TTL_SECONDS);
  } catch {
    // Best-effort only: on a Redis hiccup we fall back to the existing DB-based echo dedup.
  }
}

/** Outcome of a self-send registry read, distinguishing a genuine miss from a Redis error. */
export type SelfEchoLookup = 'self' | 'miss' | 'error';

/**
 * Read the self-send registry for an echoed message id.
 *
 * Unlike a bare boolean check, this distinguishes a genuine registry MISS (`'miss'`) from a
 * Redis READ ERROR (`'error'`) so callers can surface the currently-invisible Redis failures
 * that let the AI's own Instagram echo (which carries no `app_id`) be misclassified as a human
 * agent reply (RC-24 / P0-7). Behaviour never branches on error-vs-miss — both mean "not a
 * confirmed self-send" — but observability does.
 *
 * `'self'` means the id was one WE sent (AI reply / auto-sent product image) — a truthy Redis
 * GET; `'miss'` covers an empty id or a falsy GET; `'error'` covers a Redis read failure.
 */
export async function lookupSelfSentMessageEcho(
  externalMessageId: string | null | undefined,
  client: SelfEchoRedisClient = redisConnection,
): Promise<SelfEchoLookup> {
  const id = externalMessageId?.trim();
  if (!id) return 'miss';
  try {
    return (await client.get(selfEchoKey(id))) ? 'self' : 'miss';
  } catch {
    return 'error';
  }
}
