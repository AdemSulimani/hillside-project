import type { ChannelType } from '../db/models/channel';
import type { MessageType } from '../db/models/message';

export interface InboundMessageDTO {
  /** Discriminator. Optional for legacy callers; absence means a new inbound message. */
  kind?: 'message';
  channelType: ChannelType;
  /**
   * Thread / quoted reply — external id of the referenced message:
   * Instagram & Facebook Messenger: `message.reply_to.mid`
   * WhatsApp Cloud API: `message.context.message_id` (or `context.id`)
   */
  replyToExternalId?: string;
  /** True when Meta delivers a message echo (e.g. native Instagram app reply). */
  isEcho?: boolean;
  /**
   * For Meta echoes (`isEcho === true`): the `message.app_id` reported by the platform, when
   * present. Meta only includes `app_id` when the echoed message was sent through the Send API
   * (our AI / our inbox UI). Echoes of messages typed by a human agent in Meta's native tools
   * (Page Inbox, Business Suite, Messenger/Instagram app) carry NO `app_id`. This is the signal
   * used to tell an automated/API send apart from a genuine human-agent handoff.
   */
  echoAppId?: string | null;
  /** Inbound stored but AI reply job is skipped (reactions; stickers; emoji-only is filtered in the AI job). */
  skipAiReply?: boolean;
  channelExternalId: string;
  externalMessageId: string;
  contactExternalId: string;
  contactName: string;
  contactAvatarUrl: string | null;
  messageType: MessageType;
  content: string | null;
  attachmentUrls: string[];
  rawPayload: Record<string, unknown>;
}

/**
 * An edit notification from a Meta platform. Always references an existing message via
 * `originalExternalMessageId`; if that id was never persisted (edit arrived for a message we
 * dropped) the inbound processor will log and ignore.
 */
export interface InboundEditDTO {
  kind: 'edit';
  channelType: ChannelType;
  /** Page / IG account / WABA phone-number id; same lookup key as the message case. */
  channelExternalId: string;
  /** Platform message id of the message being edited (Messenger `mid`, WhatsApp `wamid`). */
  originalExternalMessageId: string;
  /** New text content after the edit. May be null if the platform only edited media. */
  newContent: string | null;
  /** New attachment URLs after the edit. Undefined when the platform doesn't redeliver them. */
  newAttachmentUrls?: string[];
  /** Wall-clock time the edit was reported by the platform (or now() if missing). */
  editedAt: Date;
  /** Messenger only: how many times the customer has edited this message (max 5). */
  numEdit?: number | null;
  rawPayload: Record<string, unknown>;
}

/** Union returned by the normalizer for any single webhook delivery we care about. */
export type InboundEvent = InboundMessageDTO | InboundEditDTO;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/**
 * Reads `message.app_id` from a Meta echo payload, normalising the numeric/string forms Meta
 * uses into a trimmed string. Returns `null` when absent (the human-agent native-send case).
 */
function readEchoAppId(message: Record<string, unknown> | null): string | null {
  if (!message) return null;
  const appId = message.app_id;
  if (typeof appId === 'string' && appId.trim()) return appId.trim();
  if (typeof appId === 'number' && Number.isFinite(appId)) return String(appId);
  return null;
}

/**
 * Decides whether a Meta message echo represents a reply typed by a **human agent** in Meta's
 * native surfaces (Page Inbox, Business Suite, Messenger/Instagram app) — the only echo that
 * should pause the AI and put a conversation on human hold.
 *
 * Meta attaches `message.app_id` ONLY to echoes of messages sent through the Send API
 * (our AI replies and our own inbox UI, which both call the Send API). Human agents replying
 * outside our platform produce echoes with no `app_id`. Therefore: no `app_id` ⇒ human agent;
 * an `app_id` present ⇒ an API/automated send that must NOT be treated as a human handoff.
 */
export function isHumanAgentEcho(echoAppId: string | null | undefined): boolean {
  return echoAppId == null || echoAppId.trim() === '';
}

/** Graph / Instagram IDs in JSON may be string or number; Meta dashboard tests use 0. */
function coercePositiveGraphId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return String(Math.trunc(value));
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s || s === '0') return null;
    return s;
  }
  return null;
}

function instagramMessageText(message: Record<string, unknown> | null): string | null {
  if (!message) return null;
  if (typeof message.text === 'string') return message.text;
  const textObj = asRecord(message.text);
  if (typeof textObj?.body === 'string') return textObj.body;
  return null;
}

function instagramExternalMessageId(message: Record<string, unknown> | null): string | null {
  if (!message) return null;
  if (typeof message.mid === 'string' && message.mid.trim()) return message.mid.trim();
  if (typeof message.id === 'string' && message.id.trim()) return message.id.trim();
  const idNum = typeof message.id === 'number' && Number.isFinite(message.id) ? message.id : null;
  if (idNum !== null && idNum > 0) return String(Math.trunc(idNum));
  return null;
}

/**
 * Media refs for download (Graph attachment_id or URL). Skips rich template types (`share`,
 * `ig_reel`, `reel`, `story_mention`) so their URLs — which may be permalinks or MP4s — don't
 * silently land on the vision model; those cases are fully handled by `extractMessengerRichContent`,
 * which chooses a safe preview image when one is available.
 */
function instagramAttachmentRefs(message: Record<string, unknown> | null): string[] {
  if (!message) return [];
  const refs: string[] = [];
  for (const node of instagramAttachmentNodes(message)) {
    const type = strTrim(node.type).toLowerCase();
    // Rich template types are fully resolved inside `extractMessengerRichContent`, which picks a
    // safe preview image when available. Excluding them here prevents duplicate URLs and keeps
    // video/permalink URLs off the vision path.
    if (
      type === 'share' ||
      type === 'ig_reel' ||
      type === 'reel' ||
      type === 'story_mention' ||
      type.includes('story')
    ) {
      continue;
    }
    const payload = readPayload(node);
    const url = strTrim(payload.url) || strTrim(node.url);
    if (url) refs.push(url);
    const attId = strTrim(payload.attachment_id);
    if (attId) refs.push(attId);
  }
  return uniqStrings(refs);
}

function instagramAttachmentMessageType(message: Record<string, unknown> | null): MessageType {
  if (!message) return 'text';
  const roots = instagramAttachmentRoots(message);
  const first = roots.length > 0 ? asRecord(roots[0]) : null;
  const nested = first && Array.isArray(first.data) ? asRecord(first.data[0]) : first;
  const t = typeof nested?.type === 'string' ? nested.type.toLowerCase() : '';
  if (t === 'sticker') return 'image';
  if (t === 'image' || t === 'video' || t === 'audio' || t === 'file') {
    if (t === 'video') return 'video';
    if (t === 'audio') return 'audio';
    if (t === 'file') return 'document';
    return 'image';
  }
  return instagramAttachmentRefs(message).length > 0 ? 'image' : 'text';
}

function instagramAttachmentRoots(message: Record<string, unknown> | null): unknown[] {
  if (!message) return [];
  const root = message.attachments;
  if (Array.isArray(root)) return root;
  const attObj = asRecord(root);
  if (attObj && Array.isArray(attObj.data)) return attObj.data;
  return [];
}

/** Flattened attachment items (Messenger-style `attachments` or `attachments.data[]`). */
function instagramAttachmentNodes(message: Record<string, unknown> | null): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  for (const raw of instagramAttachmentRoots(message)) {
    const att = asRecord(raw);
    if (!att) continue;
    const data = att.data;
    if (Array.isArray(data)) {
      for (const d of data) {
        const dr = asRecord(d);
        if (dr) nodes.push(dr);
      }
    } else {
      nodes.push(att);
    }
  }
  return nodes;
}

function strTrim(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Page Messenger / Instagram DM: `message.reply_to.mid` references another message in the thread. */
function messengerThreadReplyExternalId(
  message: Record<string, unknown> | null,
  currentExternalId: string | null,
): string | undefined {
  const replyTo = message ? asRecord(message.reply_to) : null;
  const mid = strTrim(replyTo?.mid);
  if (!mid || !currentExternalId || mid === currentExternalId) return undefined;
  return mid;
}

/** WhatsApp Cloud API: optional `context.message_id` (WAMID) on quoted replies. */
function whatsAppReplyToExternalId(
  message: Record<string, unknown> | null,
  currentExternalId: string | null,
): string | undefined {
  const ctx = message ? asRecord(message.context) : null;
  const ref = strTrim(ctx?.message_id) || strTrim(ctx?.id);
  if (!ref || !currentExternalId || ref === currentExternalId) return undefined;
  return ref;
}

function uniqStrings(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

function isHttpUrl(s: string): boolean {
  return s.startsWith('http://') || s.startsWith('https://');
}

function isLikelyVideoShareUrl(url: string): boolean {
  const u = url.toLowerCase();
  if (u.endsWith('.mp4') || u.includes('.mp4?')) return true;
  if (u.includes('/reel/') || u.includes('/reels/')) return true;
  if (u.includes('video') && u.includes('instagram')) return true;
  return false;
}

/**
 * True when the share URL looks like a direct image we can download and hand to the vision model.
 * Conservative on purpose — permalinks like instagram.com/p/<id>/ return HTML, so we exclude them.
 *
 * Meta's Instagram share webhooks frequently deliver the post/story preview on
 * `lookaside.fbsbx.com/ig_messaging_cdn/...` (no file extension, signed query string),
 * so we whitelist the lookaside/fbsbx/Meta CDN hosts as well as the classic cdninstagram/fbcdn ones.
 */
function isLikelyImageShareUrl(url: string): boolean {
  if (!isHttpUrl(url)) return false;
  const u = url.toLowerCase();
  if (isLikelyVideoShareUrl(u)) return false;
  if (/\.(jpg|jpeg|png|webp|gif|heic|heif)(\?|#|$)/.test(u)) return true;
  if (u.includes('cdninstagram.com')) return true;
  if (u.includes('fbcdn.net')) return true;
  if (u.includes('lookaside.fbsbx.com')) return true;
  if (u.includes('lookaside.instagram.com')) return true;
  if (u.includes('/ig_messaging_cdn/')) return true;
  return false;
}

/** Extract a shared media preview URL from a webhook attachment payload, if one exists. */
function extractShareThumbnailUrl(payload: Record<string, unknown>): string {
  const candidates = [
    payload.thumbnail_url,
    payload.preview_url,
    payload.image_url,
    payload.cover_url,
    payload.cover_image_url,
    payload.media_url,
    payload.picture,
    payload.src,
  ];
  for (const c of candidates) {
    const v = strTrim(c);
    if (v && isHttpUrl(v)) return v;
  }
  return '';
}

/** Depth-first collection of all string values that look like absolute HTTP(S) URLs. */
function collectNestedHttpsStrings(value: unknown, maxDepth: number, out: Set<string>): void {
  if (maxDepth < 0 || out.size >= 48) return;
  if (typeof value === 'string') {
    const t = value.trim();
    if (isHttpUrl(t)) out.add(t);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNestedHttpsStrings(item, maxDepth - 1, out);
    return;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectNestedHttpsStrings(v, maxDepth - 1, out);
    }
  }
}

function nestedHttpsFromPayloadAndNode(
  payload: Record<string, unknown>,
  node: Record<string, unknown>,
): string[] {
  const out = new Set<string>();
  collectNestedHttpsStrings(payload, 6, out);
  collectNestedHttpsStrings(node, 4, out);
  return [...out];
}

function readPayload(node: Record<string, unknown>): Record<string, unknown> {
  return asRecord(node.payload) ?? {};
}

/**
 * Bounds caption/description size for Instagram shares (stored content + AI context).
 * Set `INSTAGRAM_SHARE_CAPTION_MAX_CHARS` in env: default 400, `0` = omit caption body from share lines.
 */
const INSTAGRAM_SHARE_CAPTION_MAX_CHARS = (() => {
  const raw = process.env.INSTAGRAM_SHARE_CAPTION_MAX_CHARS;
  if (raw === undefined || raw.trim() === '') return 400;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 400;
})();

function truncateShareCaption(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const cap = INSTAGRAM_SHARE_CAPTION_MAX_CHARS;
  if (cap === 0) return '';
  if (t.length <= cap) return t;
  const slice = t.slice(0, cap);
  const lastSpace = slice.lastIndexOf(' ');
  const head = lastSpace > cap * 0.55 ? slice.slice(0, lastSpace) : slice;
  return `${head.trimEnd()}…`;
}

/**
 * Keeps short permalinks in the inbox line; drops huge signed CDN URLs (vision uses image
 * attachments instead — avoids multi-kB tokens per message).
 */
function displayShareLinkForText(link: string): string {
  const l = link.trim();
  if (!l) return 'https://www.instagram.com/';
  const low = l.toLowerCase();
  const tokenHeavy =
    low.includes('lookaside.fbsbx.com') ||
    low.includes('lookaside.instagram.com') ||
    low.includes('/ig_messaging_cdn/') ||
    l.length > 240;
  if (tokenHeavy) return 'https://www.instagram.com/';
  return l;
}

function formatPostShareLine(): string {
  return 'Customer shared a post';
}

function formatVideoReelLine(title: string, description: string): string {
  const parts = [`Customer shared a video/reel: ${title || 'Video'}`];
  const desc = truncateShareCaption(description);
  if (desc) parts.push(desc);
  return parts.join('\n');
}

function richLineAlreadyDeclaresShareTitle(title: string, lines: string[]): boolean {
  if (!title) return false;
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`^Customer shared a post:\\s*${escaped}\\s*—`),
    new RegExp(`^Customer shared a video/reel:\\s*${escaped}(?:\\s|$)`),
    new RegExp(`^Customer shared a product:\\s*${escaped}(?:\\s|$)`),
  ];
  return lines.some((line) => patterns.some((re) => re.test(line)));
}

function extractProductCustomerLine(node: Record<string, unknown>): string | null {
  const payload = readPayload(node);
  const productRoot = asRecord(payload.product) ?? asRecord(node.product);
  if (productRoot) {
    const id = strTrim(productRoot.id ?? productRoot.product_id ?? productRoot.retailer_id);
    const name = strTrim(productRoot.name ?? productRoot.title);
    const price = strTrim(productRoot.price);
    const currency = strTrim(productRoot.currency);
    const desc = strTrim(productRoot.description ?? productRoot.subtitle);
    if (!name && !id) return null;
    const bits = [`Customer shared a product: ${name || 'Product'}`];
    if (id) bits.push(`id: ${id}`);
    if (price) bits.push(currency ? `${price} ${currency}` : price);
    if (desc) bits.push(desc);
    return bits.join(' — ');
  }

  const elements = Array.isArray(payload.elements) ? payload.elements : [];
  const first = elements.length > 0 ? asRecord(elements[0]) : null;
  if (first) {
    const title = strTrim(first.title);
    const subtitle = strTrim(first.subtitle);
    const id = strTrim(first.id ?? first.product_id);
    if (!title && !id) return null;
    const bits = [`Customer shared a product: ${title || 'Product'}`];
    if (id) bits.push(`id: ${id}`);
    if (subtitle) bits.push(subtitle);
    return bits.join(' — ');
  }

  const type = strTrim(node.type).toLowerCase();
  if (type.includes('product') && (strTrim(payload.title) || strTrim(payload.name))) {
    const name = strTrim(payload.name) || strTrim(payload.title);
    const id = strTrim(payload.id ?? payload.product_id);
    const bits = [`Customer shared a product: ${name}`];
    if (id) bits.push(`id: ${id}`);
    return bits.join(' — ');
  }

  return null;
}

/**
 * True when inbound text was produced from Instagram rich templates (post/share/story/product).
 * Used by the AI layer to add shared-content guidance.
 */
export function inboundMessageIndicatesInstagramSharedContext(content: string | null | undefined): boolean {
  const t = (content ?? '').trim();
  if (!t) return false;
  return (
    t.startsWith('Customer shared a post') ||
    t.includes('Customer mentioned you in their story') ||
    t.includes('Customer replied to your story') ||
    t.includes('Customer shared a story') ||
    t.startsWith('Customer shared a video/reel:') ||
    t.startsWith('Customer shared a product:') ||
    t.startsWith('Customer shared content')
  );
}

type MetaMessengerRichChannel = 'facebook' | 'instagram';

interface MessengerRichExtract {
  contentLines: string[];
  attachmentRefs: string[];
  messageType: MessageType | null;
  skipAiReply?: boolean;
}

/**
 * Rich attachment handling for Page Messenger (Facebook) and Instagram DM.
 * Stories / reels / product tags are Instagram-only; stickers skip AI on all Messenger surfaces.
 */
function extractMessengerRichContent(
  message: Record<string, unknown> | null,
  channel: MetaMessengerRichChannel,
): MessengerRichExtract {
  const contentLines: string[] = [];
  const attachmentRefs: string[] = [];
  let messageType: MessageType | null = null;
  let skipAiReply = false;
  let voiceLineAdded = false;

  const isInstagram = channel === 'instagram';

  // Meta delivers story replies either as a top-level `story_reply` object or nested under
  // `reply_to.story` (newer Instagram Graph versions). Accept either shape.
  const storyReply =
    (message ? asRecord(message.story_reply) : null) ??
    (message ? asRecord(asRecord(message.reply_to)?.story) : null);
  if (isInstagram && storyReply) {
    contentLines.push('Customer replied to your story');
    const url = strTrim(storyReply.url);
    const id = strTrim(storyReply.id);
    if (url && isHttpUrl(url)) {
      attachmentRefs.push(url);
      messageType = 'image';
    } else if (id) {
      attachmentRefs.push(id);
      messageType = 'image';
    }
  }

  for (const node of instagramAttachmentNodes(message)) {
    const type = strTrim(node.type).toLowerCase();
    const payload = readPayload(node);
    const urlFromPayload = strTrim(payload.url);
    const urlFromNode = strTrim(node.url);
    const url = urlFromPayload || urlFromNode;

    if (type === 'sticker') {
      if (url) attachmentRefs.push(url);
      const attId = strTrim(payload.sticker_id ?? payload.attachment_id);
      if (attId) attachmentRefs.push(attId);
      skipAiReply = true;
      if (!messageType) messageType = 'image';
      continue;
    }

    if (isInstagram && type === 'story_mention') {
      contentLines.push('Customer mentioned you in their story');
      if (url) {
        attachmentRefs.push(url);
        messageType = 'image';
      }
      const attId = strTrim(payload.attachment_id);
      if (attId) attachmentRefs.push(attId);
      continue;
    }

    if (isInstagram) {
      const productLine = extractProductCustomerLine(node);
      if (productLine) {
        contentLines.push(productLine);
        continue;
      }
    }

    if (type === 'share') {
      const title = strTrim(payload.title);
      const description = strTrim(
        payload.description ?? payload.subtitle ?? (typeof payload.caption === 'string' ? payload.caption : ''),
      );
      const permalink = strTrim(payload.share_url) || strTrim(payload.target_url);
      const link = permalink || url || '';
      const thumbnail = extractShareThumbnailUrl(payload);

      const isVideoShare = isInstagram && !!link && isLikelyVideoShareUrl(link);
      if (isVideoShare) {
        contentLines.push(formatVideoReelLine(title, description));
      } else if (link || title) {
        contentLines.push(formatPostShareLine());
      }

      // Attach a preview image so the vision model can actually see the shared post/story. For
      // reel/video shares we only attach a thumbnail when the webhook provides one; we never
      // attach an MP4 URL since the vision model expects images.
      const mediaUrl =
        thumbnail ||
        (!isVideoShare && link && isLikelyImageShareUrl(link) ? link : '');
      if (mediaUrl) {
        attachmentRefs.push(mediaUrl);
        if (!messageType) messageType = 'image';
      }
      continue;
    }

    if (isInstagram && (type === 'ig_reel' || type === 'reel')) {
      const title = strTrim(payload.title);
      const description = strTrim(payload.description ?? payload.subtitle ?? '');
      contentLines.push(formatVideoReelLine(title, description));
      const thumbnail = extractShareThumbnailUrl(payload);
      if (thumbnail) {
        attachmentRefs.push(thumbnail);
        if (!messageType) messageType = 'image';
      }
      continue;
    }

    if (type === 'image' || type === 'animated_image') {
      if (url) attachmentRefs.push(url);
      const attId = strTrim(payload.attachment_id);
      if (attId) attachmentRefs.push(attId);
      if (!messageType) messageType = 'image';
      continue;
    }

    if (type === 'video' || type === 'audio' || type === 'file') {
      if (url) attachmentRefs.push(url);
      const attId = strTrim(payload.attachment_id);
      if (attId) attachmentRefs.push(attId);
      if (channel === 'facebook' && type === 'audio' && !voiceLineAdded) {
        contentLines.push('Customer sent a voice message');
        voiceLineAdded = true;
      }
      if (!messageType) {
        if (type === 'video') messageType = 'video';
        else if (type === 'audio') messageType = 'audio';
        else messageType = 'document';
      }
      continue;
    }

    // Stories shared through DM arrive under a variety of type names depending on how the customer
    // sent them (own story vs. someone else's, photo vs. video). We route any `*story*` variant we
    // don't already handle above into a single "Customer shared a story" line so the message is
    // never stored empty.
    //
    // Meta often omits `payload.url` and only sends `attachment_id`, or nests preview URLs inside
    // `payload` objects. `lookaside.fbsbx.com` links frequently return `video/mp4` even for
    // "photo" stories (short MP4). Prefer `attachment_id` (Graph resolves to a usable URL), then
    // any nested image-like URL, then a single video URL as a last resort (`messageType: video`).
    if (isInstagram && type.includes('story')) {
      contentLines.push('Customer shared a story');
      const thumbnail = extractShareThumbnailUrl(payload);
      const nested = nestedHttpsFromPayloadAndNode(payload, node);
      const attId = strTrim(payload.attachment_id);
      const imageFromNested = nested.find((u) => isLikelyImageShareUrl(u) && !isLikelyVideoShareUrl(u));
      const imageUrl =
        thumbnail ||
        (url && isLikelyImageShareUrl(url) && !isLikelyVideoShareUrl(url) ? url : '') ||
        imageFromNested ||
        '';
      const videoUrl =
        (url && isLikelyVideoShareUrl(url) ? url : '') || nested.find((u) => isLikelyVideoShareUrl(u)) || '';

      if (attId) {
        attachmentRefs.push(attId);
        if (!messageType) messageType = 'image';
      } else if (imageUrl) {
        attachmentRefs.push(imageUrl);
        if (!messageType) messageType = 'image';
      } else if (videoUrl) {
        attachmentRefs.push(videoUrl);
        if (!messageType) messageType = 'video';
      }
      continue;
    }

    // Catch-all for unrecognized Instagram share variants (future Meta API changes, rare
    // promotional/tag-share types, etc.). Prefer a thumbnail URL when available, and fall back to
    // a generic label so the inbox and the AI both see that the customer shared something — the
    // alternative is an empty message bubble, which is what surfaced this bug.
    if (isInstagram) {
      const title = strTrim(payload.title);
      if (!richLineAlreadyDeclaresShareTitle(title, contentLines)) {
        const label = title ? `Customer shared content: ${title}` : 'Customer shared content';
        contentLines.push(label);
      }
      const thumbnail = extractShareThumbnailUrl(payload);
      const mediaUrl =
        thumbnail || (url && isLikelyImageShareUrl(url) ? url : '');
      if (mediaUrl) {
        attachmentRefs.push(mediaUrl);
        if (!messageType) messageType = 'image';
      }
      continue;
    }
  }

  return {
    contentLines,
    attachmentRefs: uniqStrings(attachmentRefs),
    messageType,
    skipAiReply: skipAiReply || undefined,
  };
}

/** When Meta also puts the full share caption in `message.text`, drop or trim it to save tokens. */
function userTextAfterRichLines(contentLines: string[], baseText: string | null): string {
  let user = baseText?.trim() ?? '';
  const richJoined = contentLines.length > 0 ? contentLines.join('\n') : '';
  const hasPostShareLine = contentLines.some((l) => l === 'Customer shared a post');
  if (user && hasPostShareLine) {
    // For Instagram post shares, suppress caption/body text to keep AI context short.
    return '';
  }
  const shareRichForUserCap =
    Boolean(richJoined) &&
    contentLines.some(
      (l) =>
        l.startsWith('Customer shared a post') ||
        l.startsWith('Customer shared a video/reel:') ||
        l.startsWith('Customer shared content') ||
        l.includes('Customer shared a story'),
    );
  if (user && shareRichForUserCap) {
    if (richJoined.includes(user)) {
      return '';
    }
    if (
      INSTAGRAM_SHARE_CAPTION_MAX_CHARS > 0 &&
      user.length > INSTAGRAM_SHARE_CAPTION_MAX_CHARS
    ) {
      return truncateShareCaption(user);
    }
  }
  return user;
}

/** Page Messenger webhooks usually omit `sender.name` for customers; PSID + User Profile API supply the real name. */
function facebookMessengerContactName(
  isEcho: boolean,
  sender: Record<string, unknown> | null,
  recipient: Record<string, unknown> | null,
  contactExternalId: string | null,
): string {
  if (isEcho) {
    if (recipient && typeof recipient.name === 'string' && recipient.name.trim()) {
      return recipient.name.trim();
    }
    return contactExternalId ? `Messenger user ${contactExternalId}` : 'Unknown';
  }
  if (sender && typeof sender.name === 'string' && sender.name.trim()) {
    return sender.name.trim();
  }
  return contactExternalId ? `Messenger user ${contactExternalId}` : 'Unknown';
}

function buildReactionInboundDto(
  channelType: 'facebook' | 'instagram',
  entry: Record<string, unknown> | null,
  messagingItem: Record<string, unknown>,
  reaction: Record<string, unknown>,
  rawPayload: Record<string, unknown>,
): InboundMessageDTO {
  const sender = asRecord(messagingItem.sender);
  const recipient = asRecord(messagingItem.recipient);
  const channelExternalId =
    coercePositiveGraphId(entry?.id) ?? coercePositiveGraphId(recipient?.id);
  const contactExternalId =
    coercePositiveGraphId(sender?.id) ?? coercePositiveGraphId(recipient?.id);
  const mid = strTrim(reaction.mid);
  const action = strTrim(reaction.action);
  const emoji = strTrim(reaction.emoji ?? reaction.reaction);
  const ts =
    messagingItem.timestamp != null && messagingItem.timestamp !== ''
      ? String(messagingItem.timestamp)
      : '0';
  const contactPart = contactExternalId ?? 'unknown';
  const baseId = `reaction_${mid || 'nomid'}_${action || 'react'}_${ts}_${contactPart}`.replace(/\s+/g, '_');
  const externalMessageId = baseId.length > 250 ? baseId.slice(0, 250) : baseId;
  const emojiChar = emoji || 'reaction';
  const content = `Customer sent a reaction: ${emojiChar}${action && action !== 'react' ? ` (${action})` : ''}`;
  const contactName =
    channelType === 'facebook'
      ? facebookMessengerContactName(false, sender, recipient, contactExternalId)
      : sender && typeof sender.name === 'string' && sender.name.trim()
        ? sender.name.trim()
        : 'Unknown';

  if (!channelExternalId || !contactExternalId) {
    throw new Error('Invalid webhook payload: required message identifiers are missing');
  }

  return {
    channelType,
    skipAiReply: true,
    isEcho: false,
    channelExternalId,
    externalMessageId,
    contactExternalId,
    contactName,
    contactAvatarUrl: null,
    messageType: 'text',
    content,
    attachmentUrls: [],
    rawPayload,
  };
}

function instagramContactName(
  sender: Record<string, unknown> | null,
  value: Record<string, unknown> | null,
): string {
  if (sender && typeof sender.name === 'string' && sender.name.trim()) return sender.name.trim();
  if (sender && typeof sender.username === 'string' && sender.username.trim()) {
    return sender.username.trim();
  }
  if (value && typeof value.from_username === 'string' && value.from_username.trim()) {
    return value.from_username.trim();
  }
  const from = value ? asRecord(value.from) : null;
  if (from && typeof from.username === 'string' && from.username.trim()) {
    return from.username.trim();
  }
  if (from && typeof from.name === 'string' && from.name.trim()) {
    return from.name.trim();
  }
  const senderId =
    coercePositiveGraphId(sender?.id) ??
    coercePositiveGraphId(from?.id) ??
    coercePositiveGraphId(value?.sender_id);
  if (senderId) return `IG user ${senderId}`;
  return 'Unknown';
}

function instagramContactExternalId(
  message: Record<string, unknown> | null,
  sender: Record<string, unknown> | null,
  recipient: Record<string, unknown> | null,
): string | null {
  const isEcho = message?.is_echo === true;
  if (isEcho) {
    return coercePositiveGraphId(recipient?.id) ?? coercePositiveGraphId(sender?.id);
  }
  return coercePositiveGraphId(sender?.id) ?? coercePositiveGraphId(recipient?.id);
}

function pickMessageType(message: Record<string, unknown>): MessageType {
  if (typeof message.type === 'string') {
    const rawType = message.type.toLowerCase();
    if (rawType === 'text') return 'text';
    if (rawType === 'image') return 'image';
    if (rawType === 'sticker') return 'image';
    if (rawType === 'audio') return 'audio';
    if (rawType === 'video') return 'video';
    if (rawType === 'document') return 'document';
  }
  return 'text';
}

function extractMetaMessage(
  payload: Record<string, unknown>,
): Omit<InboundMessageDTO, 'channelType'> {
  const entry = Array.isArray(payload.entry) ? asRecord(payload.entry[0]) : null;
  const changes = entry && Array.isArray(entry.changes) ? asRecord(entry.changes[0]) : null;
  const value = changes ? asRecord(changes.value) : null;
  const contact = value && Array.isArray(value.contacts) ? asRecord(value.contacts[0]) : null;
  const message = value && Array.isArray(value.messages) ? asRecord(value.messages[0]) : null;

  const channelExternalId = typeof entry?.id === 'string' ? entry.id : null;
  const externalMessageId = typeof message?.id === 'string' ? message.id : null;
  const contactExternalId =
    typeof contact?.wa_id === 'string'
      ? contact.wa_id
      : typeof message?.from === 'string'
        ? message.from
        : null;
  const contactName =
    typeof (asRecord(contact?.profile)?.name) === 'string'
      ? String(asRecord(contact?.profile)?.name)
      : 'Unknown';

  const messageType = message ? pickMessageType(message) : 'text';
  const textObject = asRecord(message?.text);
  const imageObject = asRecord(message?.image);
  const videoObject = asRecord(message?.video);
  const audioObject = asRecord(message?.audio);
  const documentObject = asRecord(message?.document);

  const content =
    typeof textObject?.body === 'string'
      ? textObject.body
      : typeof documentObject?.caption === 'string'
        ? documentObject.caption
        : null;

  const mediaUrl =
    typeof imageObject?.id === 'string'
      ? imageObject.id
      : typeof videoObject?.id === 'string'
        ? videoObject.id
        : typeof audioObject?.id === 'string'
          ? audioObject.id
          : typeof documentObject?.id === 'string'
            ? documentObject.id
            : null;

  if (!channelExternalId || !externalMessageId || !contactExternalId) {
    throw new Error('Invalid webhook payload: required message identifiers are missing');
  }

  const messageTypeRaw =
    message && typeof message.type === 'string' ? message.type.toLowerCase() : '';
  const stickerObject = asRecord(message?.sticker);
  if (messageTypeRaw === 'sticker') {
    const stickerId = typeof stickerObject?.id === 'string' ? stickerObject.id : null;
    const replyToSticker = whatsAppReplyToExternalId(message, externalMessageId);
    return {
      channelExternalId,
      externalMessageId,
      contactExternalId,
      contactName,
      contactAvatarUrl: null,
      messageType: 'image',
      content: null,
      attachmentUrls: stickerId ? [stickerId] : [],
      skipAiReply: true,
      rawPayload: payload,
      ...(replyToSticker ? { replyToExternalId: replyToSticker } : {}),
    };
  }

  const replyToExternalId = whatsAppReplyToExternalId(message, externalMessageId);

  return {
    channelExternalId,
    externalMessageId,
    contactExternalId,
    contactName,
    contactAvatarUrl: null,
    messageType,
    content,
    attachmentUrls: mediaUrl ? [mediaUrl] : [],
    rawPayload: payload,
    ...(replyToExternalId ? { replyToExternalId } : {}),
  };
}

/** Page Messenger webhooks (`entry[].messaging[]`), including `message.is_echo` for native sends. */
function extractFacebookMessengerMessage(payload: Record<string, unknown>): InboundMessageDTO | null {
  const entry = Array.isArray(payload.entry) ? asRecord(payload.entry[0]) : null;
  if (!entry || !Array.isArray(entry.messaging) || entry.messaging.length === 0) {
    return null;
  }
  const messagingItem = asRecord(entry.messaging[0]);
  if (!messagingItem) return null;
  const sender = asRecord(messagingItem.sender);
  const recipient = asRecord(messagingItem.recipient);
  const reaction = asRecord(messagingItem.reaction);
  const message = asRecord(messagingItem.message);

  if (reaction && !message) {
    return buildReactionInboundDto('facebook', entry, messagingItem, reaction, payload);
  }

  if (!message) {
    throw new Error('Invalid webhook payload: required message identifiers are missing');
  }

  const isEcho = message.is_echo === true;
  const channelExternalId = isEcho
    ? coercePositiveGraphId(entry.id) ?? coercePositiveGraphId(sender?.id)
    : coercePositiveGraphId(entry.id) ?? coercePositiveGraphId(recipient?.id);

  const contactExternalId = isEcho
    ? coercePositiveGraphId(recipient?.id) ?? coercePositiveGraphId(sender?.id)
    : coercePositiveGraphId(sender?.id) ?? coercePositiveGraphId(recipient?.id);

  const externalMessageId = instagramExternalMessageId(message);
  const baseText = instagramMessageText(message);
  const rich = extractMessengerRichContent(message, 'facebook');
  const legacyRefs = instagramAttachmentRefs(message);

  const contentParts: string[] = [];
  if (rich.contentLines.length > 0) {
    contentParts.push(rich.contentLines.join('\n'));
  }
  const user = userTextAfterRichLines(rich.contentLines, baseText);
  if (user) contentParts.push(user);
  const content = contentParts.length > 0 ? contentParts.join('\n\n') : baseText;

  const attachmentUrls = uniqStrings([...rich.attachmentRefs, ...legacyRefs]);

  let messageType: MessageType =
    rich.messageType ?? instagramAttachmentMessageType(message);
  if (messageType === 'image' && attachmentUrls.length === 0) {
    messageType = 'text';
  }

  if (!channelExternalId || !externalMessageId || !contactExternalId) {
    throw new Error('Invalid webhook payload: required message identifiers are missing');
  }

  const contactName = facebookMessengerContactName(isEcho, sender, recipient, contactExternalId);

  const skipAiReply = rich.skipAiReply === true;

  const replyToExternalId = messengerThreadReplyExternalId(message, externalMessageId);

  return {
    channelType: 'facebook',
    isEcho,
    ...(isEcho ? { echoAppId: readEchoAppId(message) } : {}),
    skipAiReply: skipAiReply || undefined,
    channelExternalId,
    externalMessageId,
    contactExternalId,
    contactName,
    contactAvatarUrl: null,
    messageType,
    content,
    attachmentUrls,
    rawPayload: payload,
    ...(replyToExternalId ? { replyToExternalId } : {}),
  };
}

/**
 * Coerces a platform-supplied epoch timestamp (ms or seconds) into a Date. Falls back to NOW().
 * Messenger sends ms, WhatsApp sends seconds — accept both.
 */
function coerceEditTimestamp(value: unknown): Date {
  const fallback = new Date();
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? fallback : d;
  }
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) {
      const ms = n > 1e12 ? n : n * 1000;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? fallback : d;
    }
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return fallback;
}

/**
 * Detects a Facebook Messenger / Instagram DM edit event:
 * `entry[].messaging[].message_edit = { mid, text, num_edit }`.
 *
 * Both surfaces use the exact same shape — Meta exposes the field as `message_edits` (Messenger)
 * or `message_edit` (Instagram), but the per-event payload is identical.
 */
function extractMessengerLikeEdit(
  payload: Record<string, unknown>,
  channelType: 'facebook' | 'instagram',
): InboundEditDTO | null {
  const entry = Array.isArray(payload.entry) ? asRecord(payload.entry[0]) : null;
  if (!entry) return null;
  const messagingItem = Array.isArray(entry.messaging) ? asRecord(entry.messaging[0]) : null;
  if (!messagingItem) return null;
  const messageEdit = asRecord(messagingItem.message_edit);
  if (!messageEdit) return null;

  const mid = strTrim(messageEdit.mid);
  if (!mid) return null;

  const sender = asRecord(messagingItem.sender);
  const recipient = asRecord(messagingItem.recipient);
  // Direction follows the same recipient/sender logic as new messages: when the customer edits,
  // we look at the recipient (page/IG account) to find our channel.
  const channelExternalId =
    coercePositiveGraphId(entry.id) ??
    coercePositiveGraphId(recipient?.id) ??
    coercePositiveGraphId(sender?.id);
  if (!channelExternalId) return null;

  const newContentRaw = messageEdit.text;
  const newContent =
    typeof newContentRaw === 'string' ? newContentRaw : null;

  const numEditRaw = messageEdit.num_edit;
  let numEdit: number | null = null;
  if (typeof numEditRaw === 'number' && Number.isFinite(numEditRaw)) {
    numEdit = numEditRaw;
  } else if (typeof numEditRaw === 'string' && numEditRaw.trim()) {
    const n = Number(numEditRaw);
    if (Number.isFinite(n)) numEdit = n;
  }

  return {
    kind: 'edit',
    channelType,
    channelExternalId,
    originalExternalMessageId: mid,
    newContent,
    editedAt: coerceEditTimestamp(messagingItem.timestamp),
    ...(numEdit !== null ? { numEdit } : {}),
    rawPayload: payload,
  };
}

/**
 * Detects a WhatsApp Cloud API edit event. Meta delivers edits as a separate `messages[]` entry
 * where the message's `type` is `text` (or matching the original) AND the entry includes either:
 *   • a `context.message_id` referencing the original wamid, plus an `edited` indicator, or
 *   • a `messages[].edit` sub-object describing the new body.
 *
 * We accept both shapes defensively because the Cloud API edit payload is still evolving.
 */
function extractWhatsAppEdit(payload: Record<string, unknown>): InboundEditDTO | null {
  const entry = Array.isArray(payload.entry) ? asRecord(payload.entry[0]) : null;
  if (!entry) return null;
  const changes = Array.isArray(entry.changes) ? asRecord(entry.changes[0]) : null;
  const value = changes ? asRecord(changes.value) : null;
  const metadata = value ? asRecord(value.metadata) : null;
  const message = value && Array.isArray(value.messages) ? asRecord(value.messages[0]) : null;
  if (!message) return null;

  // Shape A: explicit `edit` sub-object on the message with the new body and original wamid.
  const editObj = asRecord(message.edit);
  // Shape B: top-level `edited: true` flag plus `context.message_id` pointing at the original.
  const isFlaggedEdited = message.edited === true || message.is_edited === true;
  const ctx = asRecord(message.context);
  const ctxMid = strTrim(ctx?.message_id) || strTrim(ctx?.id);

  let originalMid: string | null = null;
  let newContent: string | null = null;
  let timestampValue: unknown = message.timestamp;

  if (editObj) {
    originalMid =
      strTrim(editObj.message_id) ||
      strTrim(editObj.original_message_id) ||
      strTrim(editObj.wamid) ||
      ctxMid ||
      null;
    const editText = asRecord(editObj.text);
    newContent =
      (typeof editObj.body === 'string' ? editObj.body : null) ??
      (typeof editText?.body === 'string' ? editText.body : null);
    if (editObj.timestamp !== undefined) timestampValue = editObj.timestamp;
  } else if (isFlaggedEdited && ctxMid) {
    originalMid = ctxMid;
    const textObj = asRecord(message.text);
    newContent = typeof textObj?.body === 'string' ? textObj.body : null;
  } else {
    return null;
  }

  if (!originalMid) return null;

  const phoneNumberId =
    typeof metadata?.phone_number_id === 'string' ? metadata.phone_number_id.trim() : '';
  const channelExternalId = phoneNumberId || (typeof entry.id === 'string' ? entry.id : '');
  if (!channelExternalId) return null;

  return {
    kind: 'edit',
    channelType: 'whatsapp',
    channelExternalId,
    originalExternalMessageId: originalMid,
    newContent,
    editedAt: coerceEditTimestamp(timestampValue),
    rawPayload: payload,
  };
}

export class WebhookNormalizerService {
  /**
   * Single-entry normalization that returns either an inbound message or an edit notification.
   * Prefer this over the per-channel methods so callers don't need to know which shape arrived.
   */
  normalizeEvent(channelType: ChannelType, payload: Record<string, unknown>): InboundEvent {
    if (channelType === 'facebook') {
      const edit = extractMessengerLikeEdit(payload, 'facebook');
      if (edit) return edit;
      return this.normalizeFromFacebook(payload);
    }
    if (channelType === 'instagram') {
      const edit = extractMessengerLikeEdit(payload, 'instagram');
      if (edit) return edit;
      return this.normalizeFromInstagram(payload);
    }
    if (channelType === 'viber') {
      return this.normalizeFromViber(payload);
    }
    const waEdit = extractWhatsAppEdit(payload);
    if (waEdit) return waEdit;
    return this.normalizeFromWhatsApp(payload);
  }

  normalizeFromFacebook(payload: Record<string, unknown>): InboundMessageDTO {
    const fromMessenger = extractFacebookMessengerMessage(payload);
    if (fromMessenger) {
      return fromMessenger;
    }
    return {
      channelType: 'facebook',
      isEcho: false,
      ...extractMetaMessage(payload),
    };
  }

  normalizeFromInstagram(payload: Record<string, unknown>): InboundMessageDTO {
    const entry = Array.isArray(payload.entry) ? asRecord(payload.entry[0]) : null;
    const changes = entry && Array.isArray(entry.changes) ? asRecord(entry.changes[0]) : null;
    const value = changes ? asRecord(changes.value) : null;
    const messagingItem = entry && Array.isArray(entry.messaging) ? asRecord(entry.messaging[0]) : null;

    const reactionFromMessaging = messagingItem ? asRecord(messagingItem.reaction) : null;
    const messageFromMessaging = messagingItem ? asRecord(messagingItem.message) : null;
    if (messagingItem && reactionFromMessaging && !messageFromMessaging) {
      return buildReactionInboundDto('instagram', entry, messagingItem, reactionFromMessaging, payload);
    }

    const sender = (value ? asRecord(value.sender) : null) ?? (messagingItem ? asRecord(messagingItem.sender) : null);
    const recipient =
      (value ? asRecord(value.recipient) : null) ??
      (messagingItem ? asRecord(messagingItem.recipient) : null);
    const message =
      (value ? asRecord(value.message) : null) ?? (messagingItem ? asRecord(messagingItem.message) : null);

    const contactExternalId = instagramContactExternalId(message, sender, recipient);
    const externalMessageId = instagramExternalMessageId(message);
    const baseText = instagramMessageText(message);
    const rich = extractMessengerRichContent(message, 'instagram');
    const legacyRefs = instagramAttachmentRefs(message);

    const contentParts: string[] = [];
    if (rich.contentLines.length > 0) {
      contentParts.push(rich.contentLines.join('\n'));
    }
    const user = userTextAfterRichLines(rich.contentLines, baseText);
    if (user) contentParts.push(user);
    const content = contentParts.length > 0 ? contentParts.join('\n\n') : baseText;

    const attachmentUrls = uniqStrings([...rich.attachmentRefs, ...legacyRefs]);

    let messageType: MessageType =
      rich.messageType ?? instagramAttachmentMessageType(message);
    if (messageType === 'image' && attachmentUrls.length === 0) {
      messageType = 'text';
    }

    const isEcho = message?.is_echo === true;
    const channelExternalId = isEcho
      ? coercePositiveGraphId(entry?.id) ??
        coercePositiveGraphId(sender?.id) ??
        coercePositiveGraphId(value?.id)
      : coercePositiveGraphId(entry?.id) ??
        coercePositiveGraphId(value?.id) ??
        coercePositiveGraphId(recipient?.id);

    if (!channelExternalId || !externalMessageId || !contactExternalId) {
      throw new Error('Invalid webhook payload: required message identifiers are missing');
    }

    const replyToExternalId = messengerThreadReplyExternalId(message, externalMessageId);

    return {
      channelType: 'instagram',
      isEcho,
      ...(isEcho ? { echoAppId: readEchoAppId(message) } : {}),
      skipAiReply: rich.skipAiReply === true ? true : undefined,
      channelExternalId,
      externalMessageId,
      contactExternalId,
      contactName: instagramContactName(sender, value),
      contactAvatarUrl: null,
      messageType,
      content,
      attachmentUrls,
      rawPayload: payload,
      ...(replyToExternalId ? { replyToExternalId } : {}),
    };
  }

  normalizeFromWhatsApp(payload: Record<string, unknown>): InboundMessageDTO {
    const normalized = extractMetaMessage(payload);
    const entry = Array.isArray(payload.entry) ? asRecord(payload.entry[0]) : null;
    const changes = entry && Array.isArray(entry.changes) ? asRecord(entry.changes[0]) : null;
    const value = changes ? asRecord(changes.value) : null;
    const metadata = value ? asRecord(value.metadata) : null;
    const phoneNumberId =
      typeof metadata?.phone_number_id === 'string' ? metadata.phone_number_id : null;

    return {
      channelType: 'whatsapp',
      ...normalized,
      // For WhatsApp Cloud API we store channel.external_id as phone_number_id.
      // Incoming webhook entry.id is usually WABA id, which does not match our channel lookup.
      channelExternalId: phoneNumberId ?? normalized.channelExternalId,
    };
  }

  /**
   * Normalizes a Viber `message` event payload into a standard InboundMessageDTO.
   *
   * Viber webhook shape (message event):
   * {
   *   event: 'message',
   *   timestamp: <epoch ms>,
   *   message_token: <number>,
   *   sender: { id, name, avatar, country, language, api_version },
   *   message: { type, text, media, location, tracking_data, file_name, file_size, sticker_id }
   * }
   *
   * The webhook controller embeds `_viber_channel_external_id` into the payload so the
   * normalizer can resolve the channel without needing an extra DB call.
   */
  normalizeFromViber(payload: Record<string, unknown>): InboundMessageDTO {
    const sender = asRecord(payload.sender);
    const message = asRecord(payload.message);

    // The webhook controller embeds the bot's external_id into the payload.
    const channelExternalId =
      typeof payload._viber_channel_external_id === 'string'
        ? payload._viber_channel_external_id
        : '';

    const contactExternalId =
      typeof sender?.id === 'string' && sender.id.trim() ? sender.id.trim() : null;
    const contactName =
      typeof sender?.name === 'string' && sender.name.trim()
        ? sender.name.trim()
        : contactExternalId
          ? `Viber user ${contactExternalId}`
          : 'Unknown';
    const contactAvatarUrl =
      typeof sender?.avatar === 'string' && sender.avatar.trim() ? sender.avatar.trim() : null;

    const messageToken = payload.message_token;
    const externalMessageId =
      messageToken != null ? String(messageToken) : '';

    if (!channelExternalId || !externalMessageId || !contactExternalId) {
      throw new Error(
        'Invalid Viber webhook payload: required message identifiers are missing',
      );
    }

    const viberType =
      message && typeof message.type === 'string' ? message.type.toLowerCase() : 'text';

    let messageType: MessageType = 'text';
    if (viberType === 'picture') messageType = 'image';
    else if (viberType === 'video') messageType = 'video';
    else if (viberType === 'file') messageType = 'document';
    else if (viberType === 'sticker') messageType = 'image';

    const content =
      message && typeof message.text === 'string' && message.text.trim()
        ? message.text.trim()
        : null;

    // Viber delivers media as a direct URL (1-hour TTL); store it for downstream download.
    const mediaUrl =
      message && typeof message.media === 'string' && message.media.trim()
        ? message.media.trim()
        : null;

    const attachmentUrls: string[] = mediaUrl ? [mediaUrl] : [];

    // Stickers don't warrant an AI reply.
    const skipAiReply = viberType === 'sticker' ? true : undefined;

    return {
      channelType: 'viber',
      channelExternalId,
      externalMessageId,
      contactExternalId,
      contactName,
      contactAvatarUrl,
      messageType,
      content,
      attachmentUrls,
      skipAiReply,
      rawPayload: payload,
    };
  }
}

export const webhookNormalizerService = new WebhookNormalizerService();
