import type { DeliveryTime } from '../db/models/tenant';
import type { ReplyLocale } from './aiService';

const DELIVERY_TIME_LABEL_HOURS: Record<DeliveryTime, number> = {
  '24h': 24,
  '48h': 48,
  '72h': 72,
};

/** Clauses the model sometimes embeds in order confirmations; stripped before the platform ETA line. */
const EMBEDDED_MODEL_DELIVERY_ETA_CLAUSE_PATTERNS: RegExp[] = [
  /,?\s*dhe\s+do\s+të\s+dorëzohet\s+brenda\s+\d+\s+orëve\.?/gi,
  /,?\s*dhe\s+do\s+të\s+mbërrijë\s+brenda\s+\d+\s+orëve\.?/gi,
  /(?<!Produkti\s)do\s+të\s+dorëzohet\s+brenda\s+\d+\s+orëve\.?/gi,
  /,?\s*and\s+will\s+be\s+delivered\s+within\s+\d+\s+hours\.?/gi,
  /,?\s*and\s+will\s+arrive\s+within\s+\d+\s+hours\.?/gi,
  /(?<!product\s)will\s+be\s+delivered\s+within\s+\d+\s+hours\.?/gi,
];

export function normalizeForOrderConfirmationCheck(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u0027\u02BC\u2018\u2019`]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** CRM-configured ETA line inserted by the platform (before the standard follow-up). */
export function buildOrderConfirmationDeliveryLine(
  deliveryTime: DeliveryTime,
  locale: ReplyLocale,
): string {
  const hours = DELIVERY_TIME_LABEL_HOURS[deliveryTime];
  return locale === 'sq'
    ? `Produkti do të mbërrijë brenda ${hours} orëve.`
    : `Your product will arrive within ${hours} hours.`;
}

function isCanonicalDeliveryEtaParagraph(paragraph: string, deliveryLine: string | null): boolean {
  if (!deliveryLine) return false;
  return (
    normalizeForOrderConfirmationCheck(paragraph) ===
    normalizeForOrderConfirmationCheck(deliveryLine)
  );
}

function isModelDeliveryEtaOnlyParagraph(paragraph: string): boolean {
  const norm = normalizeForOrderConfirmationCheck(paragraph);
  if (!norm) return false;
  if (/^produkti do te mberrije brenda \d+ oreve$/.test(norm)) return false;
  if (/^your product will arrive within \d+ hours$/.test(norm)) return false;
  return (
    /do te (dorozohet|mberrije) brenda \d+ oreve/.test(norm) ||
    /^(porosia juaj )?do te (dorozohet|mberrije) brenda \d+ oreve$/.test(norm) ||
    /will (be delivered|arrive) within \d+ hours/.test(norm)
  );
}

function tidyConfirmationParagraph(paragraph: string): string {
  return paragraph
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/([.!?])\s*([.!?])+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Remove model-authored delivery ETA mentions; the platform inserts one canonical line. */
export function stripModelDeliveryEtaMentions(
  text: string,
  canonicalDeliveryLine: string | null = null,
): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;

  const paragraphs = trimmed.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const kept = paragraphs
    .map((paragraph) => {
      if (isCanonicalDeliveryEtaParagraph(paragraph, canonicalDeliveryLine)) {
        return paragraph;
      }
      let cleaned = paragraph;
      for (const pattern of EMBEDDED_MODEL_DELIVERY_ETA_CLAUSE_PATTERNS) {
        cleaned = cleaned.replace(pattern, '');
      }
      return tidyConfirmationParagraph(cleaned);
    })
    .filter((paragraph) => paragraph && !isModelDeliveryEtaOnlyParagraph(paragraph));

  return kept.join('\n\n').trim();
}

export function textContainsCanonicalDeliveryEta(
  text: string,
  deliveryLine: string,
): boolean {
  const norm = normalizeForOrderConfirmationCheck(text);
  const lineNorm = normalizeForOrderConfirmationCheck(deliveryLine);
  if (norm.includes(lineNorm)) return true;
  return (
    /\bprodukti do te mberrije brenda \d+ oreve\b/.test(norm) ||
    /\byour product will arrive within \d+ hours\b/.test(norm)
  );
}

function insertDeliveryLineBeforeOrderFollowUp(
  text: string,
  deliveryLine: string,
  orderFollowUp: string,
): string {
  const fuNorm = normalizeForOrderConfirmationCheck(orderFollowUp);
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const paraIdx = paragraphs.findIndex(
    (p) => normalizeForOrderConfirmationCheck(p) === fuNorm,
  );
  if (paraIdx >= 0) {
    return [...paragraphs.slice(0, paraIdx), deliveryLine, ...paragraphs.slice(paraIdx)].join(
      '\n\n',
    );
  }

  const needles = [
    orderFollowUp.trim(),
    orderFollowUp.trim().replace(/\u2019/g, "'"),
    orderFollowUp.trim().replace(/'/g, '\u2019'),
  ];
  for (const needle of needles) {
    const idx = text.lastIndexOf(needle);
    if (idx !== -1) {
      const before = text.slice(0, idx).trimEnd();
      const fromFollowUp = text.slice(idx).trimStart();
      return `${before}\n\n${deliveryLine}\n\n${fromFollowUp}`;
    }
  }

  const marker = '\nNëse keni ndonjë pyetje tjetër';
  const mIdx = text.lastIndexOf(marker);
  if (mIdx >= 0) {
    const before = text.slice(0, mIdx).trimEnd();
    const fromFollowUp = text.slice(mIdx + 1).trimStart();
    return `${before}\n\n${deliveryLine}\n\n${fromFollowUp}`;
  }

  return `${text.trim()}\n\n${deliveryLine}`;
}

export function ensureOrderConfirmationDeliveryAndFollowUp(
  replyText: string,
  deliveryLine: string | null,
  orderFollowUp: string,
): string {
  let text = stripModelDeliveryEtaMentions(replyText.trim(), deliveryLine);
  const fuNorm = normalizeForOrderConfirmationCheck(orderFollowUp);
  const hasFollowUp = normalizeForOrderConfirmationCheck(text).includes(fuNorm);

  if (deliveryLine && !textContainsCanonicalDeliveryEta(text, deliveryLine)) {
    text = hasFollowUp
      ? insertDeliveryLineBeforeOrderFollowUp(text, deliveryLine, orderFollowUp)
      : `${text}\n\n${deliveryLine}`;
  }

  if (!normalizeForOrderConfirmationCheck(text).includes(fuNorm)) {
    text = `${text.trim()}\n\n${orderFollowUp}`;
  }

  return text;
}
