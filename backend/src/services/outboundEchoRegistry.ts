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
const SELF_ECHO_TTL_SECONDS = 10 * 60;

function selfEchoKey(externalMessageId: string): string {
  return `self_send_echo:${externalMessageId}`;
}

/** Record a message id our Send API call just returned, so its later echo is recognised as ours. */
export async function markSelfSentMessageEcho(
  externalMessageId: string | null | undefined,
): Promise<void> {
  const id = externalMessageId?.trim();
  if (!id) return;
  try {
    await redisConnection.set(selfEchoKey(id), '1', 'EX', SELF_ECHO_TTL_SECONDS);
  } catch {
    // Best-effort only: on a Redis hiccup we fall back to the existing DB-based echo dedup.
  }
}

/** True when the given echoed message id was sent by us (AI reply / auto-sent product image). */
export async function wasSelfSentMessageEcho(
  externalMessageId: string | null | undefined,
): Promise<boolean> {
  const id = externalMessageId?.trim();
  if (!id) return false;
  try {
    return !!(await redisConnection.get(selfEchoKey(id)));
  } catch {
    return false;
  }
}
