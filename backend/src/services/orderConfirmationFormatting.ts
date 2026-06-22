import type { DeliveryTime } from '../db/models/tenant';
import type { ReplyLocale } from './aiService';

const DELIVERY_TIME_LABEL_HOURS: Record<DeliveryTime, number> = {
  '24h': 24,
  '48h': 48,
  '72h': 72,
};

/**
 * Reusable fragments for matching a delivery-ETA duration the model may invent.
 * The platform only ever states an hour-based ETA, so any model-authored ETA in
 * DAYS (e.g. "2-3 ditë", "2-3 days", "brenda 3 ditësh") must be stripped, along
 * with the hour-based variants the model sometimes duplicates.
 */
const DAY_DURATION = String.raw`\d+\s*(?:[-–—]\s*\d+)?\s+dit(?:ë|e)(?:t|ve|sh|ë|e)?(?:\s+(?:të\s+)?pun(?:ë|e)s)?`;
const DAY_DURATION_EN = String.raw`\d+\s*(?:[-–—]\s*\d+)?\s+(?:business\s+|working\s+)?days?`;
const HOUR_DURATION = String.raw`\d+\s+orëve`;
const HOUR_DURATION_EN = String.raw`\d+\s+hours`;

/** Clauses the model sometimes embeds in order confirmations; stripped before the platform ETA line. */
const EMBEDDED_MODEL_DELIVERY_ETA_CLAUSE_PATTERNS: RegExp[] = [
  // Hour-based ETA the model duplicates (the platform inserts the only canonical hour line).
  new RegExp(String.raw`,?\s*dhe\s+do\s+të\s+dorëzohet\s+brenda\s+${HOUR_DURATION}\.?`, 'gi'),
  new RegExp(String.raw`,?\s*dhe\s+do\s+të\s+mbërrijë\s+brenda\s+${HOUR_DURATION}\.?`, 'gi'),
  new RegExp(String.raw`(?<!Produkti\s)do\s+të\s+dorëzohet\s+brenda\s+${HOUR_DURATION}\.?`, 'gi'),
  new RegExp(String.raw`,?\s*and\s+will\s+be\s+delivered\s+within\s+${HOUR_DURATION_EN}\.?`, 'gi'),
  new RegExp(String.raw`,?\s*and\s+will\s+arrive\s+within\s+${HOUR_DURATION_EN}\.?`, 'gi'),
  new RegExp(String.raw`(?<!product\s)will\s+be\s+delivered\s+within\s+${HOUR_DURATION_EN}\.?`, 'gi'),
  // Day-based ETA the model invents — the platform never states delivery in days.
  // Albanian: "Koha (e parashikuar) e dorëzimit/dërgesës (është) (brenda) 2-3 ditëve të punës."
  new RegExp(
    String.raw`,?\s*(?:dhe\s+)?koha\s+(?:e\s+parashikuar\s+)?(?:e\s+)?(?:dorëzimit|dërgesës|dergeses|dorezimit)\s+(?:është\s+|eshte\s+)?(?:brenda\s+|afërsisht\s+|afersisht\s+)?(?:është\s+|eshte\s+)?${DAY_DURATION}\.?`,
    'gi',
  ),
  // Albanian: "(dhe) do të dorëzohet/mbërrijë brenda 2-3 ditëve (të punës)."
  new RegExp(
    String.raw`,?\s*(?:dhe\s+)?do\s+të\s+(?:dorëzohet|mbërrijë|dorezohet|mberrije)\s+brenda\s+${DAY_DURATION}\.?`,
    'gi',
  ),
  // English: "The estimated delivery time is within 2-3 business days."
  new RegExp(
    String.raw`,?\s*(?:dhe\s+|and\s+)?(?:the\s+)?(?:estimated\s+)?delivery\s+(?:time|date)\s+is\s+(?:within\s+|approximately\s+)?${DAY_DURATION_EN}\.?`,
    'gi',
  ),
  // English: "(and) will be delivered/arrive within 2-3 (business) days."
  new RegExp(
    String.raw`,?\s*(?:and\s+)?will\s+(?:be\s+delivered|arrive)\s+within\s+${DAY_DURATION_EN}\.?`,
    'gi',
  ),
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
  // After normalization diacritics are stripped and "2-3" collapses to "2 3".
  const dayDuration = String.raw`\d+(?:\s+\d+)?\s+dit\w*`;
  const dayDurationEn = String.raw`\d+(?:\s+\d+)?\s+(?:business |working )?days?`;
  return (
    /do te (dorozohet|mberrije) brenda \d+ oreve/.test(norm) ||
    /^(porosia juaj )?do te (dorozohet|mberrije) brenda \d+ oreve$/.test(norm) ||
    /will (be delivered|arrive) within \d+ hours/.test(norm) ||
    new RegExp(String.raw`do te (dorozohet|mberrije) brenda ${dayDuration}`).test(norm) ||
    new RegExp(String.raw`koha .*(dorezimit|dergeses).*${dayDuration}`).test(norm) ||
    new RegExp(String.raw`delivery (time|date) is (within |approximately )?${dayDurationEn}`).test(norm) ||
    new RegExp(String.raw`will (be delivered|arrive) within ${dayDurationEn}`).test(norm)
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

  const marker = '\nNëse keni pyetje';
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
