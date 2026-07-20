/**
 * P2-5 (RC-25, RC-26): the platform business rulebook, code-owned.
 *
 * THE DEFECT THIS FIXES. `buildRestrictionsFooter` is correct, data-driven code — it renders
 * whatever is in `ai_configs.restrictions` / `ai_configs.platform_restrictions` and returns ''
 * when both are empty. There is NO render bug (the remediation plan's "fix the render path" is
 * a misreading). The defect is a DATA gap, verified against the live DB:
 *
 *   - `restrictions`          → populated on exactly 1 of 6 tenants (17 hand-typed Albanian rules)
 *   - `platform_restrictions` → `[]` on ALL 6 — the "PLATFORM POLICY" footer has never rendered
 *   - `business.md`           → a repo-root file that NO code reads
 *
 * So five of six tenants run with no business rules in-prompt at all, and the platform's own
 * policy has never reached a single reply. Worse, the one tenant that has them has PLATFORM
 * policy hand-typed into its OPERATOR slot — tenant-owned data an admin can silently empty.
 *
 * WHY A CODE CONSTANT rather than seeding the column (the three options considered):
 *   - Seeding `platform_restrictions` per tenant needs a SECOND change in tenant-creation to
 *     avoid drifting for every new tenant — which is the exact bug class that produced the
 *     orphan `offers_promotions` block. It is also silently emptiable from the admin panel
 *     (AdminBusinessAiPanel), and every edit needs a new migration.
 *   - A platform-locked prompt_block loses the footer's whole premise: last-position priority.
 *     Blocks render at their `sort_order`, buried inside a ~17.9K-char guidelines wall, and
 *     would additionally be subject to the P2-5 prompt budget.
 *   - A code constant is git-versioned, reviewable, has no data to seed and no drift, cannot be
 *     emptied by an admin, and keeps the footer's last-position priority. `platform_restrictions`
 *     remains a per-tenant OVERRIDE for the rare tenant that needs one.
 *
 * The recommendation/alternative count is 2–3 — the only decided-and-shipped value, live in 6/6
 * tenants since migration 066 (`guidelines.catalog_integrity`, `guidelines.recommendations`).
 * `business.md` still said 1–2 and the platform-locked `guidelines.category_product_aggregation`
 * was missed by 066; migration 080 finishes that job. `platformPolicy.test.ts` pins 2–3 here so
 * the four sites cannot drift apart again (C-03).
 *
 * LOCALE. The rules are authored per locale and selected by the resolved reply locale — never
 * hardcoded Albanian (DP-pc-18: `SHARED_CONTENT_SYSTEM_APPEND` makes exactly that mistake and
 * violates the language lock on English conversations).
 */
// Type-only import so there is no runtime import cycle back into aiService — the same pattern
// `cannedReplyText.ts` and `stickyLocale.ts` use.
import type { ReplyLocale } from './aiService';
import { knobBool } from '../config/knobs';

// P3-5 (step 0): read through the manifest rather than the inline idiom. The bool idiom cannot
// drift on the PARSE (knobs.test.ts says so, and it is right), but it does drift on VISIBILITY —
// an inline read is absent from the "overridden from default" boot line unless someone remembers
// to duplicate it, and this flag decides whether the platform rulebook reaches a reply at all.
export const RESTRICTIONS_FOOTER_ALL_TENANTS = knobBool('RESTRICTIONS_FOOTER_ALL_TENANTS');

/** A single platform rule. `id` is stable across locales so the pair can be asserted complete. */
export interface PlatformRule {
  id: string;
  text: string;
}

/**
 * The Albanian rulebook — rule-for-rule `business.md`, reconciled to 2–3 (R7/R13/R17).
 * Sourced from the 17 rules verified in the live DB (EV-029), which are themselves an Albanian
 * translation of `business.md`. This is the canonical copy; the DB rows are now redundant.
 */
export const PLATFORM_POLICY_RULES_SQ: readonly PlatformRule[] = [
  {
    id: 'R1',
    text:
      'Nëse mesazhi i klientit nuk lidhet në asnjë mënyrë me produktet, dyqanin apo biznesin tonë, ' +
      'përgjigju vetëm me [NO_REPLY] dhe asgjë tjetër. PËRJASHTIM: përshëndetjet, falënderimet dhe ' +
      'mesazhet mbyllëse (p.sh. "përshëndetje", "faleminderit", "mirupafshim") nuk janë jashtë teme — ' +
      'përgjigju gjithmonë me një fjali të shkurtër e të sjellshme, mos përdor [NO_REPLY] për to.',
  },
  { id: 'R2', text: 'Përdor vetëm informacionin nga katalogu dhe konteksti i bisedës.' },
  { id: 'R3', text: 'Mos shpik informata për produkte, çmime, stok ose dërgesë.' },
  {
    id: 'R4',
    text:
      'Përmend çmimin vetëm kur klienti pyet direkt për çmim, ose kur klienti pyet për krahasim ' +
      'çmimesh (p.sh. "cili është më i lirë?", "cili kushton më pak?", "krahaso çmimet"). Pyetjet e ' +
      'krahasimit të çmimit janë pyetje direkte çmimi — duhet të përgjigjesh duke treguar emrin dhe ' +
      'çmimin e secilit produkt të listuara sipas formatit: "Emri i produktit: €X".',
  },
  { id: 'R5', text: 'Mos përmend stokun ose sasinë në stok pa pyetje direkte nga klienti.' },
  { id: 'R6', text: 'Nëse produkti nuk është në katalog, thuaj qartë që nuk është në dispozicion.' },
  {
    id: 'R7',
    text:
      'Mos rekomando, mos promovo dhe mos krahaso me marka, produkte ose çmime të konkurrentëve. ' +
      'Përjashtim: nëse klienti pyet ose dërgon foto të një marke që ne nuk e mbajmë, mund ta thuash ' +
      'ndershmërisht se nuk e mbajmë atë markë dhe të ofrosh 2-3 alternativa nga katalogu.',
  },
  { id: 'R8', text: 'Shkruaj përgjigje të shkurtra, të qarta dhe natyrale.' },
  { id: 'R9', text: 'Mos përdor markdown ose formatime speciale.' },
  { id: 'R10', text: 'Mos premto afate ose rezultate që nuk janë të konfirmuara.' },
  {
    id: 'R11',
    text:
      'Nëse mesazhi klasifikohet si sinjal i përfundimit të bisedës, kthe vetëm një fjali të shkurtër ' +
      'dhe të sjellshme përmbyllëse; mos bëj pyetje shtesë dhe mos hap tema të reja.',
  },
  {
    id: 'R12',
    text:
      'Draft porosia lejohet vetëm kur klienti e konfirmon qartë porosinë sipas classifier + kontekstit. ' +
      'Pyetjet për produkt (çmim, stok, detaje, krahasim) nuk llogariten si konfirmim porosie.',
  },
  {
    id: 'R13',
    text:
      'Kur klienti pyet nëse keni një produkt të saktë dhe ai nuk është në dispozicion, thuaj qartë dhe ' +
      'sugjero 2-3 alternativa nga e njëjta kategori. PËRJASHTIM: kur pyetja është krahasim çmimesh ose ' +
      'rekomandim mes disa produkteve dhe njëri prej tyre nuk është në stok, prapëseprapë inkludoje në ' +
      'krahasim me çmimin e tij dhe shëno shkurt se nuk është aktualisht i disponueshëm — mos e ' +
      'zëvendëso të gjithë përgjigjen me alternativa.',
  },
  {
    id: 'R14',
    text:
      'Nëse klienti raporton vonesë në dërgesë, mos-dërgesë, produkt të gabuar të marrë, ose produkt me ' +
      'defekt pas blerjes, dërgo një falje të shkurtër dhe trego që një anëtar i ekipit do t\'i ' +
      'përgjigjet së shpejti.',
  },
  {
    id: 'R15',
    text:
      'Nëse klienti bën një pyetje për përdorim/dozim që nuk përgjigjet nga seksioni i përdorimit në ' +
      'katalog, kaloje te një specialist njerëzor me një fjali të shkurtër dhe të sjellshme.',
  },
  {
    id: 'R16',
    text:
      'Për pyetje ku klienti pyet cili produkt është më i lirë, më i shtrenjtë, ose kur kërkon krahasim ' +
      'çmimesh (p.sh. "cili është më i lirë?", "cili kushton më pak?", "cili është më i shtrenjtë?", ' +
      '"krahaso çmimet"), analizo produktet e disponueshme dhe jep përgjigje të drejtpërdrejtë. Formati: ' +
      'emri i produktit dhe çmimi në çdo rresht (p.sh. "Produkti A: €25 / Produkti B: €30"), me ' +
      'identifikim të drejtpërdrejtë se cili është më i lirë ose më i shtrenjtë. Mos shkakto alarme ose ' +
      'njoftime specialiste për këto pyetje — ke të gjitha të dhënat e katalogut të nevojshme.',
  },
  {
    id: 'R17',
    text:
      'Për pyetje rekomandimi ose vendimi (p.sh. "cilin do ta rekomandonit?", "cilën më sugjeron?", ' +
      '"cilën mkishe than ti?", "which would you recommend?"), analizo produktet nga katalogu dhe jep ' +
      'përgjigje të drejtpërdrejtë me 2-3 produkte. Mos shkakto alarme ose njoftime specialiste për këto ' +
      'pyetje — ke të gjitha të dhënat e katalogut të nevojshme për të krahasuar dhe rekomanduar.',
  },
  {
    id: 'R18',
    text:
      'Kur klienti kërkon foto të një produkti, sistemi e dërgon foton automatikisht — mos thuaj ' +
      'kurrë që nuk mund të dërgosh foto dhe mos u justifiko për fotot; përgjigju shkurt e ' +
      'natyrshëm vetëm për produktet që kërkoi klienti.',
  },
];

/** The English rulebook — `business.md` verbatim, reconciled to 2–3. Same ids as the sq set. */
export const PLATFORM_POLICY_RULES_EN: readonly PlatformRule[] = [
  {
    id: 'R1',
    text:
      "If the customer's message is not related in any way to our products, store, or business, reply " +
      'only with [NO_REPLY] and nothing else. EXCEPTION: greetings, thank-you messages, and ' +
      'conversation-closing messages (e.g. "hello", "thank you", "goodbye") are not considered ' +
      'off-topic — always respond with a short, polite sentence and never use [NO_REPLY] for them.',
  },
  { id: 'R2', text: 'Use only the information available in the product catalog and the conversation context.' },
  { id: 'R3', text: 'Do not invent information about products, prices, stock, or shipping.' },
  {
    id: 'R4',
    text:
      'Mention a product\'s price only when the customer explicitly asks for the price, or when the ' +
      'customer asks for a price comparison (e.g. "Which one is cheaper?", "Which costs less?", ' +
      '"Compare the prices."). Price comparison questions are direct price questions — you must respond ' +
      'by listing the name and price of each relevant product using the format: "Product Name: €X".',
  },
  { id: 'R5', text: 'Do not mention stock availability or stock quantity unless the customer explicitly asks about it.' },
  { id: 'R6', text: 'If a product is not available in the catalog, clearly state that it is not available.' },
  {
    id: 'R7',
    text:
      'Do not recommend, promote, or compare competitor brands, products, or prices. EXCEPTION: if the ' +
      'customer asks about or sends a photo of a brand that we do not carry, you may honestly state that ' +
      'we do not carry that brand and offer 2-3 suitable alternatives from our catalog.',
  },
  { id: 'R8', text: 'Keep responses short, clear, and natural.' },
  { id: 'R9', text: 'Do not use Markdown or any special formatting.' },
  { id: 'R10', text: 'Do not promise delivery times, results, or outcomes unless they are explicitly confirmed.' },
  {
    id: 'R11',
    text:
      'If the message is classified as a conversation-ending signal, return only a short, polite closing ' +
      'sentence. Do not ask additional questions or introduce new topics.',
  },
  {
    id: 'R12',
    text:
      'A draft order may only be created when the customer clearly confirms the order according to the ' +
      'classifier and the conversation context. Questions about products (price, stock, details, ' +
      'comparisons, etc.) do not count as order confirmation.',
  },
  {
    id: 'R13',
    text:
      'When the customer asks whether you have a specific product and it is not available, clearly state ' +
      'that it is unavailable and suggest 2-3 alternatives from the same category. EXCEPTION: if the ' +
      'customer is asking for a price comparison or a recommendation between multiple products and one of ' +
      'them is unavailable, still include that product in the comparison with its price and briefly ' +
      'indicate that it is currently unavailable — do not replace the entire response with alternatives.',
  },
  {
    id: 'R14',
    text:
      'If the customer reports a delayed delivery, a missing delivery, receiving the wrong product, or ' +
      'receiving a defective product after purchase, send a brief apology and inform them that a member ' +
      'of our team will respond as soon as possible.',
  },
  {
    id: 'R15',
    text:
      "If the customer asks a usage or dosage question that cannot be answered using the product catalog's " +
      'usage section, escalate the conversation to a human specialist with a short, polite response.',
  },
  {
    id: 'R16',
    text:
      'For questions asking which product is the cheapest, the most expensive, or requesting a price ' +
      'comparison (e.g. "Which one is cheaper?", "Which costs less?", "Which one is the most expensive?", ' +
      '"Compare the prices."), analyze the available products and provide a direct answer. Format each ' +
      'product on a separate line with its name and price (e.g. "Product A: €25" / "Product B: €30"), and ' +
      'clearly identify which product is the cheapest or the most expensive. Do not trigger specialist ' +
      'alerts or notifications for these questions — you have all the catalog data required to answer them.',
  },
  {
    id: 'R17',
    text:
      'For recommendation or decision-making questions (e.g. "Which one would you recommend?", "What do ' +
      'you suggest?", "Which one would you choose?"), analyze the products in the catalog and provide a ' +
      'direct recommendation of 2-3 products. Do not trigger specialist alerts or notifications for these ' +
      'questions — you have all the catalog data required to compare products and make recommendations.',
  },
  {
    id: 'R18',
    text:
      'When the customer asks for a product photo, the system sends the photo automatically — never ' +
      'say you cannot send photos and never apologize about photos; reply briefly and naturally, ' +
      'covering only the products the customer asked about.',
  },
];

/**
 * Sentence prepended to the platform footer when the code-owned rulebook is in play, making the
 * precedence explicit rather than positional. The footer already renders operator rules first and
 * platform rules last, and "last = highest priority" is the footer's stated design — so platform
 * policy already wins by position. This states it in words for the model.
 */
export const PLATFORM_POLICY_PRECEDENCE_NOTE_BY_LOCALE: Record<ReplyLocale, string> = {
  sq: 'Këto rregulla të platformës kanë përparësi ndaj çdo rregulli operatori më sipër që bie ndesh me to.',
  en: 'These platform rules override any conflicting operator rule above.',
};

/**
 * The platform rules to render for a tenant: the tenant's own `platform_restrictions` when set
 * (an admin override), otherwise the code-owned rulebook for the reply locale.
 *
 * Flag-off returns the raw column verbatim — byte-identical to today, which for every one of the
 * 6 live tenants means `[]` and therefore no footer at all.
 */
export function resolvePlatformRestrictions(
  config: { platform_restrictions?: string[] | null },
  locale: ReplyLocale,
  enabled: boolean = RESTRICTIONS_FOOTER_ALL_TENANTS,
): string[] {
  const configured = Array.isArray(config.platform_restrictions) ? config.platform_restrictions : [];
  if (configured.length > 0) return configured;
  if (!enabled) return [];
  return (locale === 'en' ? PLATFORM_POLICY_RULES_EN : PLATFORM_POLICY_RULES_SQ).map((r) => r.text);
}

/** Whether the code-owned default (rather than a tenant override or nothing) will be rendered. */
export function usesPlatformPolicyDefault(
  config: { platform_restrictions?: string[] | null },
  enabled: boolean = RESTRICTIONS_FOOTER_ALL_TENANTS,
): boolean {
  const configured = Array.isArray(config.platform_restrictions) ? config.platform_restrictions : [];
  return enabled && configured.length === 0;
}

/**
 * The slice of ai_config the footer reads. Structural (not `Pick<typeof DEFAULT_AI_CONFIG,…>`)
 * so this module needs no runtime import back into aiService.
 *
 * Both keys are REQUIRED even though their values may be null: a caller that forgot to load the
 * ai_config must fail at compile time rather than silently render an empty footer — which is the
 * exact "no business rules in the prompt" outcome this module exists to eliminate.
 */
export interface RestrictionsFooterConfig {
  restrictions: string[] | null | undefined;
  platform_restrictions: string[] | null | undefined;
}

/**
 * Builds the operator restrictions footer, appended near-last to every system prompt (only the
 * P2-1 grounding directive follows it — see the priority ladder at the append site in aiService).
 * Placing these after the product catalog, guidelines and runtime appends ensures the model
 * treats them as the highest-priority operator/platform instructions and does not let earlier
 * prompt sections dilute them.
 *
 * Operator rules render FIRST and platform policy LAST, so platform policy already wins by
 * position; the precedence note states it in words as well.
 *
 * P2-5 (RC-25): this function was never broken — it renders whatever is in the arrays and
 * returns '' when both are empty. The defect was that `platform_restrictions` is `[]` for all 6
 * tenants and `restrictions` is populated for only 1. `resolvePlatformRestrictions` supplies the
 * code-owned rulebook when the tenant has no override, which is what makes the footer reach 6/6.
 *
 * Lives here rather than in aiService so it stays pure and unit-testable: importing aiService
 * pulls in the OpenAI client, which is why the house convention keeps logic in pure modules.
 */
export function buildRestrictionsFooter(
  config: RestrictionsFooterConfig,
  // Required: both call sites (the production reply path and the admin preview) already resolve a
  // locale, and defaulting here would silently duplicate aiService's DEFAULT_REPLY_LOCALE — which
  // cannot be imported without reintroducing the runtime cycle, so it would drift on any change.
  locale: ReplyLocale,
): string {
  const parts: string[] = [];

  const restrictions = Array.isArray(config.restrictions) ? config.restrictions : [];
  if (restrictions.length > 0) {
    parts.push(
      `\n\nOPERATOR BUSINESS RULES — you MUST follow:\n${restrictions.map((r) => `- ${r}`).join('\n')}`,
    );
  }

  const platformRestrictions = resolvePlatformRestrictions(config, locale);
  if (platformRestrictions.length > 0) {
    const precedenceNote = usesPlatformPolicyDefault(config)
      ? `\n${PLATFORM_POLICY_PRECEDENCE_NOTE_BY_LOCALE[locale]}`
      : '';
    parts.push(
      `\n\nPLATFORM POLICY — follow strictly:${precedenceNote}\n${platformRestrictions.map((r) => `- ${r}`).join('\n')}`,
    );
  }

  return parts.join('');
}
