/**
 * Pure, side-effect-free helpers for usage/suitability question detection.
 *
 * Deliberately kept in a separate module from aiService.ts so that unit tests
 * can import these functions without triggering the openaiClient module-level
 * initialisation (which requires OPENAI_API_KEY at load time).
 *
 * aiService.ts re-exports everything from here so call-sites are unaffected.
 */

/** Exported for unit-testing keyword coverage. LLM call is the primary classifier; these are the fallback. */
export const USAGE_QUESTION_KEYWORDS = [
  'how to use',
  'how do i use',
  'how should i use',
  'how to take',
  'how do i take',
  'dosage',
  'dose',
  'application',
  'apply',
  'instructions',
  'warning',
  'warnings',
  'side effects',
  'usage',
  'use it',
  'take it',
  // Suitability / personal circumstance / compatibility questions (EN)
  'suitable for me',
  'suitable for',
  'is it suitable',
  'is this suitable',
  'is it safe',
  'is this safe',
  'safe for me',
  'safe to use',
  'can i use',
  'can i take',
  'any problem if',
  'any problems if',
  'is there a problem',
  'is there any problem',
  'any issues if',
  'any issue if',
  'without working out',
  'without exercising',
  'without exercise',
  'no exercise',
  "don't work out",
  'do not work out',
  'not working out',
  "i don't exercise",
  'i do not exercise',
  'not exercising',
  // Albanian (base keywords)
  'si ta përdor',
  'si e përdor',
  'si duhet ta përdor',
  'si ta marr',
  'si e marr',
  'dozimi',
  'dozë',
  'aplikim',
  'apliko',
  'udhëzime',
  'paralajmërim',
  'paralajmërime',
  'efekte anësore',
  'efekte anesore',
  'përdorim',
  'përdore',
  'merre',
  'perdor',
  'qysh me perdor',
  // Albanian suitability / compatibility / safety keywords
  'a mund ta perdor',
  'a mund ta përdor',
  'a mund ta marr',
  'a ka problem',
  'a ka ndonje problem',
  'a ka ndonjë problem',
  'pa stervitje',
  'pa stërvitje',
  'pa ushtrime',
  'pa ushtruar',
  'pa sport',
  'nuk stervitem',
  'nuk stërvitem',
  'nuk ushtroj',
  'nuk bej sport',
  'nuk bëj sport',
  'a eshte i sigurt',
  'a është i sigurt',
  'a eshte e sigurt',
  'a është e sigurt',
  'i pershtatshem',
  'i përshtatshëm',
  'e pershtatshem',
  'e përshtatshme',
  'per mua',
  'për mua',
  'a i pershtatet',
  'a i përshtatet',
];

export function includesAnyKeyword(message: string, keywords: string[]): boolean {
  const t = message.trim().toLowerCase();
  if (!t) return false;
  return keywords.some((needle) => t.includes(needle));
}

/** Returns true when the message matches the keyword-fallback list for usage questions. */
export function matchesUsageQuestionKeyword(message: string): boolean {
  return includesAnyKeyword(message, USAGE_QUESTION_KEYWORDS);
}

/**
 * Detects whether an AI-generated reply contains speculative health or medical advice
 * that originates from the model's training knowledge rather than the product catalog.
 *
 * Patterns like "consult a health professional", "consult a doctor", "it is important to
 * consult", "speak to a healthcare provider", etc. are strong signals that the AI went
 * beyond catalog data. Used as a safety-net guard in processAIReply.ts: if the reply
 * matches these patterns AND the usage description does NOT contain the same pattern
 * (i.e. the advice isn't catalog-backed), the conversation must be escalated rather than
 * sending speculative medical guidance to the customer.
 *
 * Albanian equivalents are included. Keep the list conservative — only include phrases
 * that are clearly health/medical consultation recommendations.
 */
export function containsSpeculativeHealthAdvice(text: string): boolean {
  if (!text.trim()) return false;
  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  const patterns = [
    // English — consultation recommendations
    'consult a health professional',
    'consult a doctor',
    'consult a dietitian',
    'consult a nutritionist',
    'consult a physician',
    'consult a healthcare',
    'consult your doctor',
    'consult your physician',
    'consult your healthcare',
    'it is important to consult',
    "it's important to consult",
    'important to consult',
    'we recommend consulting',
    'we recommend you consult',
    'recommend consulting',
    'speak to a doctor',
    'speak to a healthcare',
    'speak with a doctor',
    'speak with a healthcare',
    'speak with a physician',
    'talk to a doctor',
    'talk to a physician',
    'talk to a healthcare',
    'talk with a doctor',
    'seek medical advice',
    'seek professional advice',
    'seek the advice',
    'always consult',
    'should consult',
    'consult with a',
    'consult with your',
    'healthcare provider',
    'health professional',
    'medical professional',
    'professional advice',
    'medical advice',
    // Albanian — consultation / health-professional patterns (diacritics stripped above)
    'konsultohuni me mjek',
    'konsultohuni me specialist',
    'konsulto mjekun',
    'konsultoni mjekun',
    'keshillohuni me mjek',
    'keshillohuni me specialist',
    'keshillohu me mjek',
    'flisni me mjekun',
    'flisni me nje mjek',
    'mjek nutricionist',
    'mjek specialist',
    'nutricionist',
    'dietolog',
    'specialist shendetesie',
    'keshilla mjekesore',
    'keshilla profesionale',
  ];

  return patterns.some((p) => normalized.includes(p));
}
