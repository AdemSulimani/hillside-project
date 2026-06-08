import type { TenantPromptBlockRow } from '../db/models/promptBlock';

/** Mirrors `ReplyLocale` in aiService (kept separate to avoid circular imports). */
export type GuidelineAssemblyLocale = 'sq' | 'en';

const VISION_BLOCK_KEY = 'guidelines.vision_product_images';

/** Expand {{TOKEN}} placeholders in guideline blocks; unknown tokens stay unchanged. */
export function expandPromptPlaceholders(template: string, map: Record<string, string>): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, token: string) =>
    Object.prototype.hasOwnProperty.call(map, token) ? map[token] : `{{${token}}}`,
  );
}

export type GuidelinePlaceholderContext = {
  language: GuidelineAssemblyLocale;
};

export function buildGuidelinePlaceholderMap(ctx: GuidelinePlaceholderContext): Record<string, string> {
  const isSq = ctx.language === 'sq';
  const languageName = isSq ? 'Albanian (shqip)' : 'English';
  const otherLanguageName = isSq ? 'English' : 'Albanian';

  const orderClosingExample = isSq ? 'A doni ta porosisni?' : 'Would you like to order it?';
  const orderClosingFallback = isSq
    ? 'Produkti është në dispozicion nëse doni ta porosisni'
    : 'The product is available if you would like to order it';

  const discountOfferExample = isSq
    ? "Mund t'jua ofrojmë me [discounted_price]."
    : 'We can offer it for [discounted_price].';

  const noFurtherDiscountSentence = isSq
    ? 'Më vjen keq, nuk mund të aplikohet zbritje shtesë. Çmimi që ju ofruam është final.'
    : 'I am sorry, no additional discount can be applied. The price we offered is final.';

  const noDiscountAvailableSentence = isSq
    ? 'Për këtë produkt nuk është e mundur asnjë zbritje, çmimi aktual është final.'
    : 'No discount is available for this product; the current price is final.';

  const orderConfirmationFollowUp = isSq
    ? 'Nëse keni ndonjë pyetje tjetër apo dëshironi të porosisni diçka tjetër, jam këtu për t\u2019ju ndihmuar.'
    : 'If you have any other questions or would like to place another order, I am here to help.';

  const dataConfirmationSentence = isSq
    ? 'Faleminderit për porosinë tuaj! Për të shmanguar çdo gabim, a mund të konfirmoni që të dhënat që keni dhënë janë korrekte?'
    : 'Thank you for your order! To avoid any mistakes, could you please confirm that the information you provided is correct?';

  const postPurchaseIssueSentence = isSq
    ? 'Përshëndetje, na vjen keq për problemin. Pas pak, një anëtar i ekipit tonë do t\u2019ju përgjigjet.'
    : 'Hello, we are sorry for the issue. A member of our team will get back to you shortly.';

  const fixedPhraseLanguageDirective = isSq ? 'In Albanian use exactly' : 'In English use exactly';
  const orderConfirmationLanguageDirective = isSq
    ? 'in Albanian only (this is the ONLY follow-up allowed in an order-confirmation reply, and it must appear exactly once)'
    : 'in English only (this is the ONLY follow-up allowed in an order-confirmation reply, and it must appear exactly once)';
  const postPurchaseLanguageDirective = isSq
    ? 'reply with exactly one Albanian sentence and nothing else'
    : 'reply with exactly one English sentence and nothing else';

  return {
    LANGUAGE_NAME: languageName,
    OTHER_LANGUAGE_NAME: otherLanguageName,
    ORDER_CLOSING_EXAMPLE: orderClosingExample,
    ORDER_CLOSING_FALLBACK: orderClosingFallback,
    DISCOUNT_OFFER_EXAMPLE: discountOfferExample,
    DISCOUNT_RULE_NO_FURTHER: `${fixedPhraseLanguageDirective}: "${noFurtherDiscountSentence}"`,
    DISCOUNT_RULE_NONE_AVAILABLE: `${fixedPhraseLanguageDirective}: "${noDiscountAvailableSentence}"`,
    ORDER_CONFIRMATION_CLOSING_RULE: `- If you confirm that an order is placed/confirmed, end the message with this exact follow-up sentence ${orderConfirmationLanguageDirective}: "${orderConfirmationFollowUp}"`,
    DELIVERY_ETA_NOTE: `- When the business has configured a delivery-time window in the CRM, the platform inserts one ${languageName} sentence with that ETA immediately before that follow-up; do not add your own separate delivery-arrival time line in order-confirmation replies (avoid duplicating it).`,
    POST_PURCHASE_ESCALATION_RULE: `- If the customer reports a delivery delay/non-delivery, wrong item received, or product defect/problem after purchase, ${postPurchaseLanguageDirective}: "${postPurchaseIssueSentence}"`,
    DATA_CONFIRMATION_SENTENCE: `"${dataConfirmationSentence}"`,
  };
}

export function assembleGuidelinesFromBlocks(
  rows: TenantPromptBlockRow[],
  placeholderCtx: GuidelinePlaceholderContext,
  opts: { hasImages: boolean },
): string {
  const map = buildGuidelinePlaceholderMap(placeholderCtx);
  const sorted = [...rows].sort((a, b) => {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return a.block_key.localeCompare(b.block_key);
  });

  const parts: string[] = [];
  for (const row of sorted) {
    if (!row.enabled) continue;
    if (row.block_key === VISION_BLOCK_KEY && !opts.hasImages) continue;
    const expanded = expandPromptPlaceholders(row.content, map).trim();
    if (expanded) parts.push(expanded);
  }

  return parts.join('\n\n');
}
