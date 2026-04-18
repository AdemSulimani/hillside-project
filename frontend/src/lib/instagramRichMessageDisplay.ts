/**
 * Parses Instagram rich inbound lines produced by the backend webhook normalizer
 * (see backend/src/services/webhookNormalizer.ts).
 */

export type InstagramRichParsed =
  | {
      kind: 'post_share';
      title: string;
      url: string;
      description: string | null;
      userCaption: string | null;
      thumbnailUrl: string | null;
    }
  | {
      kind: 'story_mention';
      extraRichLines: string | null;
      userCaption: string | null;
      previewUrl: string | null;
    }
  | {
      kind: 'story_reply';
      extraRichLines: string | null;
      userCaption: string | null;
      previewUrl: string | null;
    }
  | {
      kind: 'reel_share';
      title: string;
      description: string | null;
      userCaption: string | null;
    }
  | {
      kind: 'product_tag';
      productName: string;
      subtitle: string | null;
      userCaption: string | null;
    };

const POST = 'Customer shared a post:';
const STORY_MENTION = 'Customer mentioned you in their story';
const STORY_REPLY = 'Customer replied to your story';
const REEL = 'Customer shared a video/reel:';
const PRODUCT = 'Customer shared a product:';

function splitRichAndUserCaption(full: string): { richBlock: string; userCaption: string | null } {
  const trimmed = full.trim();
  const parts = trimmed.split('\n\n');
  if (parts.length <= 1) {
    return { richBlock: trimmed, userCaption: null };
  }
  const richBlock = parts[0]?.trim() ?? '';
  const userCaption = parts.slice(1).join('\n\n').trim() || null;
  return { richBlock, userCaption };
}

function firstImageLikeUrl(urls: string[]): string | null {
  for (const u of urls) {
    if (!u || !/^https?:\/\//i.test(u)) continue;
    const lower = u.toLowerCase();
    if (
      lower.includes('.jpg') ||
      lower.includes('.jpeg') ||
      lower.includes('.png') ||
      lower.includes('.webp') ||
      lower.includes('.gif') ||
      lower.includes('image')
    ) {
      return u;
    }
  }
  return urls.find((u) => u && /^https?:\/\//i.test(u)) ?? null;
}

function parsePostShare(richBlock: string, userCaption: string | null, attachmentUrls: string[]): InstagramRichParsed | null {
  if (!richBlock.startsWith(POST)) return null;
  const lines = richBlock.split('\n');
  const first = lines[0] ?? '';
  const restDesc = lines.slice(1).join('\n').trim() || null;

  const after = first.slice(POST.length).trim();
  const sep = ' — ';
  const idx = after.lastIndexOf(sep);
  let title: string;
  let url: string;
  if (idx === -1) {
    const urlMatch = after.match(/(https?:\/\/\S+)/);
    if (!urlMatch) return null;
    url = urlMatch[1].replace(/[,.)]+$/, '');
    title = after.replace(urlMatch[0], '').trim() || 'Post';
  } else {
    title = after.slice(0, idx).trim() || 'Post';
    url = after.slice(idx + sep.length).trim();
    if (!/^https?:\/\//i.test(url)) {
      const m = after.match(/(https?:\/\/\S+)/);
      if (!m) return null;
      url = m[1].replace(/[,.)]+$/, '');
    }
  }

  const thumb = firstImageLikeUrl(attachmentUrls);

  return {
    kind: 'post_share',
    title,
    url,
    description: restDesc,
    userCaption,
    thumbnailUrl: thumb,
  };
}

function parseReelShare(richBlock: string, userCaption: string | null): InstagramRichParsed | null {
  if (!richBlock.startsWith(REEL)) return null;
  const lines = richBlock.split('\n');
  const title = lines[0]?.slice(REEL.length).trim() || 'Video';
  const description =
    lines.length > 1 ? lines.slice(1).join('\n').trim() || null : null;
  return { kind: 'reel_share', title, description, userCaption };
}

function parseProductTag(richBlock: string, userCaption: string | null): InstagramRichParsed | null {
  if (!richBlock.startsWith(PRODUCT)) return null;
  const lines = richBlock.split('\n');
  const first = lines[0] ?? '';
  const after = first.slice(PRODUCT.length).trim();
  const sep = ' — ';
  const i = after.indexOf(sep);
  const productName = (i === -1 ? after : after.slice(0, i)).trim() || 'Product';
  const subtitleParts: string[] = [];
  if (i !== -1) subtitleParts.push(after.slice(i + sep.length).trim());
  if (lines.length > 1) subtitleParts.push(lines.slice(1).join('\n').trim());
  const subtitle = subtitleParts.filter(Boolean).join('\n') || null;
  return {
    kind: 'product_tag',
    productName,
    subtitle,
    userCaption,
  };
}

function parseStoryMention(richBlock: string, userCaption: string | null, attachmentUrls: string[]): InstagramRichParsed | null {
  const lines = richBlock.split('\n');
  const first = lines[0]?.trim() ?? '';
  if (first !== STORY_MENTION) return null;
  const extraRichLines = lines.slice(1).join('\n').trim() || null;
  const previewUrl = attachmentUrls[0] ?? firstImageLikeUrl(attachmentUrls);
  return { kind: 'story_mention', extraRichLines, userCaption, previewUrl: previewUrl ?? null };
}

function parseStoryReply(richBlock: string, userCaption: string | null, attachmentUrls: string[]): InstagramRichParsed | null {
  const lines = richBlock.split('\n');
  const first = lines[0]?.trim() ?? '';
  if (first !== STORY_REPLY) return null;
  const extraRichLines = lines.slice(1).join('\n').trim() || null;
  const previewUrl = attachmentUrls[0] ?? firstImageLikeUrl(attachmentUrls);
  return { kind: 'story_reply', extraRichLines, userCaption, previewUrl: previewUrl ?? null };
}

/**
 * Returns structured Instagram rich UI data when `content` matches backend patterns.
 */
export function parseInstagramRichDisplay(
  content: string | null | undefined,
  attachmentUrls: string[],
): InstagramRichParsed | null {
  const text = content?.trim() ?? '';
  if (!text) return null;

  const { richBlock, userCaption } = splitRichAndUserCaption(text);

  const storyReply = parseStoryReply(richBlock, userCaption, attachmentUrls);
  if (storyReply) return storyReply;

  const storyMention = parseStoryMention(richBlock, userCaption, attachmentUrls);
  if (storyMention) return storyMention;

  const product = parseProductTag(richBlock, userCaption);
  if (product) return product;

  const reel = parseReelShare(richBlock, userCaption);
  if (reel) return reel;

  const post = parsePostShare(richBlock, userCaption, attachmentUrls);
  if (post) return post;

  return null;
}

/** Attachment URLs to show below the rich card (e.g. exclude thumb already shown in card). */
export function attachmentUrlsAfterRichUse(
  parsed: InstagramRichParsed,
  attachmentUrls: string[],
): string[] {
  if (parsed.kind === 'post_share' && parsed.thumbnailUrl) {
    return attachmentUrls.filter((u) => u !== parsed.thumbnailUrl);
  }
  if (parsed.kind === 'story_mention' || parsed.kind === 'story_reply') {
    if (parsed.previewUrl) {
      return attachmentUrls.filter((u) => u !== parsed.previewUrl);
    }
  }
  return [...attachmentUrls];
}
