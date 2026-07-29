/**
 * P2-7 (RC-15, RC-04, RC-06, RC-17, RC-03 config side) — the env-knob manifest.
 *
 * THE PROBLEM. The audit found standing environmental divergence: the same input produces
 * different outcomes across workers and deploys purely by config provenance. Knobs were read with
 * ad-hoc `parseFloat(process.env.X || '0.65')` expressions scattered across ~75 files, several with
 * no NaN guard (a typo'd SIMILARITY_THRESHOLD yields NaN, every `similarity >= NaN` is false, and
 * semantic retrieval silently dies fleet-wide), several silently reverting to a default with no log
 * (INTENT_THRESHOLD=1 quietly becomes 0.85 — the OPPOSITE of what the operator asked for), and 47
 * absent from `.env.example` entirely. `validateEnv` itself re-read env with its own duplicated
 * default literals, making the validator a drift source.
 *
 * THE SHAPE. Every knob is declared ONCE here with its parser, band, requiredness and read
 * lifetime. Detection is severity-FREE (`detect`) and a pure table (`applyMode`) assigns severity,
 * so the whole fatal/warn matrix is testable as a pure function. `env` is always a PARAMETER, never
 * `process.env` — that is what lets the tests cover it without global mutation (the repo has no
 * mocking framework; see services/__tests__/logger.test.ts for the alternative it avoids).
 *
 * INVARIANT — LEAF MODULE: no module-load throw, no console, no process.exit, no DB/Redis. Only
 * `node:crypto` and `./models` (also a leaf) are imported. `openaiClient` must be able to import
 * this transitively without an exit becoming reachable from any import.
 */
import { createHash } from 'node:crypto';
import {
  EMBEDDING_MODEL_DIMS,
  EXPECTED_EMBEDDING_DIM,
  modelEnvKeys,
  resolveModel,
} from './models';

export type KnobKind = 'string' | 'int' | 'float' | 'bool' | 'enum';

/**
 * RC-06's drift axis: does a live env change reach the consumer?
 *  - 'frozen'   — read once into a module-load const. A rolling deploy that changes it makes worker
 *                 identity a hidden variable, so these are exactly the knobs the fingerprint hashes.
 *  - 'per-call' — re-read each call; takes effect mid-process.
 *  - 'boot'     — only bootstrap/validateEnv reads it.
 */
export type Binding = 'frozen' | 'per-call' | 'boot';

/**
 * The warn-mode discriminant. P2-7's stated edge case is that warn-only "must distinguish
 * 'required and missing' (fail) from 'optional, using default' (info-log)". Making that a
 * STRUCTURAL property of the spec — rather than a heuristic over the message text — is what makes
 * the distinction reliable.
 */
export type Requiredness =
  | { kind: 'required' }
  | { kind: 'required-in-production' }
  | { kind: 'optional'; default: string | number | boolean };

export interface KnobSpec {
  key: string;
  kind: KnobKind;
  requiredness: Requiredness;
  binding: Binding;
  /**
   * Numeric band. Outside ⇒ `out_of_band`; unparseable ⇒ `unparseable`.
   * Inclusive by default; `exclusive` makes both endpoints open, matching a consumer whose own
   * guard reads `> min && < max` (see INTENT_THRESHOLD).
   */
  band?: { min: number; max: number; exclusive?: boolean };
  /** Allowed values for kind:'enum'. */
  values?: readonly string[];
  /** Mirrored into `.env.example`; also the boot log text. */
  description: string;
  /** Never printed, never fingerprinted by value (hashed only). */
  secret?: boolean;
  /** Override the default fingerprint rule (`binding === 'frozen'`). */
  fingerprint?: boolean;
  /** WHY this band/default is what it is. Data, not prose, so it survives the next refactor. */
  rationale?: string;
  /** Set false for knobs deliberately absent from `.env.example` (test-only hooks). */
  documented?: boolean;
}

const bool = (key: string, def: boolean, description: string, extra: Partial<KnobSpec> = {}): KnobSpec => ({
  key,
  kind: 'bool',
  requiredness: { kind: 'optional', default: def },
  binding: 'frozen',
  description,
  ...extra,
});

const num = (
  key: string,
  kind: 'int' | 'float',
  def: number,
  band: { min: number; max: number; exclusive?: boolean },
  binding: Binding,
  description: string,
  extra: Partial<KnobSpec> = {},
): KnobSpec => ({
  key,
  kind,
  requiredness: { kind: 'optional', default: def },
  binding,
  band,
  description,
  ...extra,
});

/**
 * The manifest.
 *
 * Scope note: this covers the AI-decision knobs the audit implicated in divergent outcomes, the
 * required secrets, and the P0–P2 feature flags — i.e. everything whose drift can change what a
 * customer is told or how they are billed. Pure-infrastructure knobs (Backblaze/Cloudinary keys,
 * pool sizes, cron expressions) are deliberately NOT enumerated: they fail loudly and locally, they
 * do not silently reclassify a message, and enumerating them would make this file a second copy of
 * `.env.example` that rots. Add one here the moment it gains a band or a decision role.
 */
export const KNOBS: readonly KnobSpec[] = [
  // --- Required secrets / connections (missing ⇒ fatal in EVERY mode) -----------------------
  //
  // `fingerprint: true` despite `binding: 'boot'`: these are read once per process and NEVER
  // legitimately differ between instances, so a divergence is a severe incident that the frozen-only
  // default rule would miss. Two API instances on different JWT_SECRETs randomly reject each other's
  // tokens (users see intermittent logouts with nothing in the logs); two on different DATABASE_URLs
  // is worse. Their VALUES are hashed, never stored — see `fingerprint()`.
  { key: 'DATABASE_URL', kind: 'string', requiredness: { kind: 'required' }, binding: 'boot', secret: true, fingerprint: true, description: 'PostgreSQL connection string' },
  { key: 'JWT_SECRET', kind: 'string', requiredness: { kind: 'required' }, binding: 'boot', secret: true, fingerprint: true, description: 'Signing secret for access tokens' },
  { key: 'JWT_REFRESH_SECRET', kind: 'string', requiredness: { kind: 'required' }, binding: 'boot', secret: true, fingerprint: true, description: 'Signing secret for refresh tokens' },
  { key: 'OPENAI_API_KEY', kind: 'string', requiredness: { kind: 'required' }, binding: 'boot', secret: true, fingerprint: true, description: 'OpenAI API key for AI features' },

  // --- Models (guards 4 + 5). All chat-family roles fall back to OPENAI_CHAT_MODEL. ---------
  { key: 'OPENAI_CHAT_MODEL', kind: 'string', requiredness: { kind: 'optional', default: 'gpt-4o' }, binding: 'frozen', description: 'Main chat model; the fallback for every chat-family role' },
  {
    key: 'OPENAI_EMBEDDING_MODEL',
    kind: 'string',
    // Required in every environment: there is no safe default. A wrong dimension silently disables
    // semantic retrieval fleet-wide (RC-04), so we refuse to guess.
    requiredness: { kind: 'required' },
    binding: 'frozen',
    description: `Embedding model. MUST be ${EXPECTED_EMBEDDING_DIM}-dim to match the embedding columns`,
    rationale:
      'products.embedding is vector(1536) (migration 029). text-embedding-3-large is 3072-dim and ' +
      'would make every similarity query error. Guarded at boot + verified against the real column ' +
      'dimension by `npm run config:check`.',
  },
  { key: 'OPENAI_CLASSIFIER_MODEL', kind: 'string', requiredness: { kind: 'optional', default: '(OPENAI_CHAT_MODEL)' }, binding: 'frozen', description: 'Model for the boolean/structured classifier fan-out (~25 sites). Falls back to OPENAI_CHAT_MODEL' },
  { key: 'OPENAI_VISION_MODEL', kind: 'string', requiredness: { kind: 'optional', default: '(OPENAI_CHAT_MODEL)' }, binding: 'frozen', description: 'Vision/image analysis model' },
  { key: 'OPENAI_EVAL_MODEL', kind: 'string', requiredness: { kind: 'optional', default: '(OPENAI_CHAT_MODEL)' }, binding: 'per-call', description: 'Reply-quality evaluation model' },
  { key: 'OPENAI_INTENT_MODEL', kind: 'string', requiredness: { kind: 'optional', default: '(OPENAI_CHAT_MODEL)' }, binding: 'per-call', description: 'Purchase-intent detection model' },
  { key: 'OPENAI_PRODUCT_PROCESSING_MODEL', kind: 'string', requiredness: { kind: 'optional', default: '(OPENAI_CHAT_MODEL, else gpt-4o-mini)' }, binding: 'frozen', description: 'Model for product extraction from uploaded documents/images' },
  { key: 'OPENAI_FINETUNING_BASE_MODEL', kind: 'string', requiredness: { kind: 'optional', default: 'gpt-4o-mini-2024-07-18' }, binding: 'frozen', description: 'Base model for fine-tuning jobs' },
  {
    // P3-6. Declared here rather than read inline in `services/modelPricing.ts` — where it lived
    // until now — because a price table is config that DECIDES A REPORTED NUMBER. Left as a bare
    // `process.env` read it was invisible to `detectExampleDrift`, to `config:check`, and to the
    // fleet fingerprint, so two instances carrying different tables would publish divergent COGS
    // for identical traffic and nothing would say so. That is the same shape as SIMILARITY_
    // THRESHOLD's inline NaN: not a wrong value, an UNGOVERNED one.
    key: 'OPENAI_MODEL_PRICES',
    kind: 'string',
    requiredness: { kind: 'optional', default: '' },
    binding: 'frozen',
    description:
      'Per-model token price overrides for COGS, JSON map of {model: {inputPerM, outputPerM, ' +
      'cachedInputPerM?}} in USD per 1M tokens. Empty ⇒ the built-in table',
    rationale:
      'Prices change without a code change, so the table is externalizable by design (the P3-6 ' +
      'edge case "Model price table drift"). Malformed JSON is ignored fail-open: a bad price ' +
      'string must degrade the COST REPORT, never the reply path that imports this module.',
  },

  // --- Decision thresholds (guards 2 + 3 + 6) -----------------------------------------------
  num('SIMILARITY_THRESHOLD', 'float', 0.65, { min: 0, max: 1 }, 'frozen',
    'Minimum cosine similarity (0-1) for a product to pass the semantic retrieval filter', {
      rationale:
        '0.65 balances recall/precision for dense catalogs; 0.75 caused false-negatives at 0.70-0.74. ' +
        'Had NO isFinite guard before P2-7: a typo yielded NaN, every `similarity >= NaN` was false, ' +
        'and semantic retrieval died silently fleet-wide.',
    }),
  num('QUALITY_THRESHOLD', 'float', 0.1, { min: 0, max: 1 }, 'per-call',
    'Quality-eval alert floor (0-1). Replies scoring below it are flagged and PAUSE the AI', {
      rationale:
        'DO NOT "tighten" this to 0.6 without first moving the quality eval off the send path (P3-4). ' +
        'The eval model scores order confirmations a systematic 0.200 (EV-018) — a false low. At 0.1 ' +
        'that miscalibration is inert; at 0.6 EVERY order confirmation would flag and pause the AI at ' +
        'checkout, with no auto-resume (RC-14). `.env.example` shipped 0.6 until P0-2 reconciled it; ' +
        'the band exists so it cannot drift back.',
    }),
  num('INTENT_THRESHOLD', 'float', 0.85, { min: 0, max: 1, exclusive: true }, 'per-call',
    'Minimum purchase-intent score to create a draft order (exclusive: must be >0 and <1)', {
      rationale:
        'The band is EXCLUSIVE to match the consumer\'s long-standing `>0 && <1` guard — P2-7 reports ' +
        'the rejection instead of changing it. INTENT_THRESHOLD=1 (a plausible way to say "never ' +
        'auto-create orders") silently reverted to 0.85 with no log, creating orders aggressively: ' +
        'the exact opposite of the operator\'s intent. It still reverts, but now it says so. If ' +
        '"never auto-order" needs to be expressible, that is a product decision, not a band change.',
    }),
  num('AI_REPLY_TEMPERATURE', 'float', 0.3, { min: 0, max: 1 }, 'frozen',
    'Sampling temperature for the customer-facing reply', {
      rationale:
        'Band capped at 1 (not the API max of 2): above ~1 the reply is unusable prose. NOTE the ' +
        'default 0.3 is NOT deterministic — live-replay measured 1, 3 and 8 distinct replies for three ' +
        'fixed inputs (RC-03/EV-044). Determinism arrives via FACTS_USED_CONTRACT (temp 0 + seed).',
    }),
  num('AI_REPLY_SEED', 'int', 7, { min: 0, max: 2_147_483_647 }, 'frozen',
    'Fixed seed for the deterministic reply completion (only sent when FACTS_USED_CONTRACT=true)'),

  // --- Pipeline knobs the audit tied to divergent outcomes (RC-06) ---------------------------
  num('AI_MAX_REPLIES_PER_HOUR', 'int', 25, { min: 1, max: 1000 }, 'per-call', 'Per-conversation AI reply rate limit'),
  num('AI_HISTORY_FETCH_LIMIT', 'int', 40, { min: 1, max: 500 }, 'frozen', 'Messages loaded for AI context'),
  num('AI_REPLY_DELAY_MS', 'int', 8000, { min: 0, max: 120_000 }, 'per-call', 'Debounce window before an AI reply job runs (burst merge)'),
  num('HUMAN_HOLD_MINUTES', 'int', 10, { min: 0, max: 1440 }, 'per-call', 'How long AI holds after a human reply'),
  num('COMMISSION_SESSION_GAP_HOURS', 'int', 3, { min: 1, max: 168 }, 'frozen', 'Session boundary for commission eligibility'),
  num('EMBEDDING_QUERY_TIMEOUT_MS', 'int', 5000, { min: 100, max: 60_000 }, 'frozen', 'Timeout for OpenAI query-embedding calls'),
  num('AI_MAX_CONCURRENT_PER_TENANT', 'int', 8, { min: 1, max: 100 }, 'frozen', 'Per-tenant concurrent AI reply slots'),
  num('AI_CONVERSATION_LOCK_TTL_MS', 'int', 300_000, { min: 1000, max: 3_600_000 }, 'frozen', 'Per-conversation processing lock TTL'),
  num('AI_FAIRNESS_BASE_DELAY_MS', 'int', 3000, { min: 100, max: 300_000 }, 'frozen',
    'Base delay before an admission-deferred ai.reply job retries; doubles per hop (P3-2/C-79)', {
      rationale:
        'Was a hard-coded 3000 literal in processAIReply, outside both this manifest and ' +
        '.env.example — the single number governing how hard the fairness gate re-adds jobs, and ' +
        'untunable without a deploy. Under the legacy flat-3s loop N starved jobs produced N new ' +
        'jobs every 3s forever; the bounded mode doubles this per hop up to AI_FAIRNESS_MAX_DELAY_MS.',
    }),
  num('AI_FAIRNESS_MAX_DELAY_MS', 'int', 60_000, { min: 1000, max: 900_000 }, 'frozen',
    'Ceiling for a single admission deferral delay (P3-2)'),
  num('AI_FAIRNESS_MAX_HOPS', 'int', 8, { min: 1, max: 100 }, 'frozen',
    'How many times one inbound may be deferred before it is shed to the DLQ (P3-2)', {
      rationale:
        'With the default 3000ms base this is ~3+6+12+24+48+60+60+60 ≈ 4.5 minutes of total wait ' +
        'before shedding. A shed is NOT silent — it raises AdmissionShedError so the P1-2 path ' +
        'writes a dead_letter row plus an ai_reply_undelivered alert. It deliberately does NOT ' +
        'pause the conversation: capacity is a global condition and ai_paused has no automatic ' +
        'exit, so pausing would turn a transient burst into permanent per-conversation silence.',
    }),
  // Read by the boot posture logs. Declared here so their defaults exist in ONE place — before
  // P2-7 each was duplicated as a literal inside validateEnv's log strings, which is how the
  // validator became a drift source in its own right.
  num('LEDGER_RETENTION_DAYS', 'int', 90, { min: 1, max: 3650 }, 'frozen', 'How long AI decision-ledger rows are retained'),
  // P2-audit follow-up: four decision knobs that were still bare `parseInt(process.env...)` reads
  // after P2-7 — the exact inline-parse drift class this manifest exists to kill. Declared here so
  // they get band validation, boot reporting, example-drift protection and fingerprint coverage.
  num('LEDGER_RETENTION_INTERVAL_MS', 'int', 3_600_000, { min: 60_000, max: 86_400_000 }, 'frozen',
    'How often the ledger retention sweep runs (P2-4)'),

  // --- P3-6: COGS rollup + budget alerting (RC-17/RC-03, OBS-2/C-108) ----------------------
  // Every one is optional with a band and defaults to off/inert, so no new BOOT FATAL is
  // introduced and `ci.yml`'s backend-smoke env block needs no change (CLAUDE.md §11).
  // Declared with the P3-6 batch because it shares their defect (a bare process.env read) and
  // their subject (cost): a cached verdict is a classifier call not made on a retry.
  bool('CLASSIFIER_VERDICT_PERSISTENCE', false,
    'Persist per-(conversation, inbound, detector) classifier verdicts in Redis so a job retry reuses them (P1-3)'),
  bool('AI_COST_ROLLUP_ENABLED', false,
    'Fold ai_decision_ledger usage into the ai_cost_daily COGS rollup (P3-6)'),
  bool('AI_COST_JOB_CAPTURE', false,
    'Record background-job OpenAI spend (product imports, image fingerprints) into ai_cost_daily (P3-6)'),
  num('AI_COST_ROLLUP_INTERVAL_MS', 'int', 3_600_000, { min: 60_000, max: 86_400_000 }, 'frozen',
    'How often the COGS rollup sweep runs (P3-6)'),
  num('AI_COST_ROLLUP_WINDOW_DAYS', 'int', 3, { min: 1, max: 90 }, 'frozen',
    'Trailing days of ledger re-folded on each COGS sweep', {
      rationale:
        'The sweep re-folds a window instead of tracking a watermark, so a missed tick or a late ' +
        'outbox-drained ledger write self-heals on the next run. Must exceed the longest expected ' +
        'gap between sweeps plus the outbox relay lag, or a late row lands in an already-swept ' +
        'day and is never counted.',
    }),
  num('AI_COST_ROLLUP_SEAL_DAYS', 'int', 7, { min: 1, max: 90 }, 'frozen',
    'Age at which a COGS day is frozen and never recomputed', {
      rationale:
        'MUST stay well below LEDGER_RETENTION_DAYS (90). Sealing is what stops a later sweep ' +
        'from recomputing a day whose ledger rows have been partly pruned — that would silently ' +
        'SHRINK a historical cost, failing in the direction that reads as an improvement.',
    }),
  num('AI_COST_ROLLUP_RETENTION_DAYS', 'int', 730, { min: 30, max: 3650 }, 'frozen',
    'How long ai_cost_daily rows are retained', {
      rationale:
        'Deliberately OUTLIVES LEDGER_RETENTION_DAYS (90) — that asymmetry is the rollup\'s whole ' +
        'justification. The ledger expires because it carries customer-derived prompt previews; ' +
        'the rollup holds only model ids and counters, so it carries no such obligation and can ' +
        'answer year-over-year margin questions the ledger structurally cannot.',
    }),
  bool('AI_COST_ANOMALY_ALERTS', false,
    'Emit platform-ops alerts on COGS anomalies (margin inversion, runaway conversation, model drift) (P3-6)'),
  bool('AI_COST_MODEL_DRIFT_ALERT', false,
    'Alert when one role served two different models in a period, or an unpriced model appears (P3-6)', {
      rationale:
        'RC-17 made visible: the 900s delete-only ai_config cache can serve a stale custom_model_id, ' +
        'so two workers answer the same tenant on different models mid-conversation. That was ' +
        'undetectable until P1-5 captured model-id per call. The unpriced-model half is the price- ' +
        'table drift canary — an unpriced call is counted but costs 0, so a new OpenAI model id ' +
        'makes reported COGS drift DOWNWARD, which reads as an improvement.',
    }),
  num('AI_COST_MARGIN_ALERT_RATIO', 'float', 0, { min: 0, max: 10 }, 'frozen',
    'Alert when a tenant\'s month COGS / its billed revenue reaches this ratio. 0 = off'),
  num('AI_COST_CONVERSATION_ALERT_USD', 'float', 0, { min: 0, max: 1000 }, 'frozen',
    'Alert when one conversation\'s AI spend reaches this many USD. 0 = off'),
  num('AI_COST_TURN_CALL_ALERT', 'int', 0, { min: 0, max: 10_000 }, 'frozen',
    'Alert when one turn makes this many OpenAI calls. 0 = off', {
      rationale:
        'Measured baseline is 18-21 calls/turn, so ~40 is the operator value that catches the ' +
        'C-126 signature — hasAssistantAskedOrderClosingInConversation runs an uncached ' +
        'classifier over every assistant message, twice per job, and grows with conversation depth.',
    }),
  num('AI_COST_ALERT_REARM_FACTOR', 'float', 0.9, { min: 0.1, max: 1 }, 'frozen',
    'A tripped cost alert re-arms only once the measure falls below threshold x this factor', {
      rationale:
        'Two-level hysteresis (the redisMemoryMonitor shape), not the single-level breaker in ' +
        'deadLetterMonitor: a ratio hovering exactly at its threshold would otherwise re-alert ' +
        'on every tick.',
    }),
  num('GROUNDING_GATE_STRIP_FLOOR', 'int', 24, { min: 0, max: 2000 }, 'frozen',
    'Min grounded chars that must survive a targeted strip before the gate escalates the turn (P2-1)'),
  num('NAME_GUARD_SIMILARITY_THRESHOLD', 'float', 0.48, { min: 0, max: 1 }, 'frozen',
    'Min pg_trgm word_similarity for a suspected product name to be rescued as a real catalog item', {
      rationale:
        'Pre-existing since P0-2 but declared here only with P3-1 — it was a bare parseFloat IIFE ' +
        'in catalogGuardReferenceService, i.e. exactly the inline-parse class this manifest exists ' +
        'to kill (an unparseable SIMILARITY_THRESHOLD is how NaN silently disabled semantic ' +
        'retrieval fleet-wide). Behaviour is unchanged: readKnob falls back to the default on a ' +
        'non-finite or out-of-band value just as the IIFE did — what is new is that the drift is ' +
        'now REPORTED. 0.48 was calibrated empirically (2026-07-12) on the 257-row dev catalog ' +
        'with a 29-item labelled corpus: 16 realistic typos scored 0.500-0.870 (all rescued), 10 ' +
        'pure fabrications scored 0.143-0.467 (all still flagged); 0.48 is the midpoint of the ' +
        'empirical gap and avoids the knife edge at 0.50. Raise toward 0.7 only to catch invented ' +
        'near-variants at the cost of escalating heavier typos. Band is inclusive [0,1] to match ' +
        'every sibling similarity knob; 0 degenerates to rescue-everything, which is the ' +
        'fail-OPEN direction and therefore the safe one for a guard.',
    }),
  num('IMAGE_REQUEST_MAX_TARGETS', 'int', 3, { min: 1, max: 10 }, 'frozen',
    'Max products one customer photo request may resolve to (images sent + missing-photo notices)', {
      rationale:
        'A bare "foto produktet" once resolved to the entire 10-row retrieval-fusion pool ' +
        '(conversation 9e84a4ee, 2026-07-20): one image sent plus 9 unrequested product names ' +
        'enumerated. Customers ask for photos of what is being discussed — the platform recommends ' +
        'at most 2-3 products per turn — so 3 covers every legitimate request with one spare while ' +
        'making the pool-blast shape impossible.',
    }),
  num('IMAGE_REQUEST_MAX_MISSING_NAMES', 'int', 2, { min: 0, max: 10 }, 'frozen',
    'Max product names the "we will send the photo shortly" notice may enumerate', {
      rationale:
        'Above this many missing-image products the notice drops names entirely and sends one ' +
        'generic line — ≥3 missing names on a single photo request is retrieval noise, not ' +
        'customer intent, and enumerating them reads as introducing products the customer never ' +
        'asked about.',
    }),
  num('IMAGE_REQUEST_NAME_SIMILARITY_THRESHOLD', 'float', 0.48, { min: 0, max: 1 }, 'frozen',
    'Min pg_trgm word_similarity for catalog recovery of a named photo request', {
      rationale:
        'Reuses the NAME_GUARD_SIMILARITY_THRESHOLD calibration (2026-07-12, 257-row dev catalog: ' +
        'typos 0.500-0.870, fabrications 0.143-0.467; 0.48 sits in the gap) but is declared ' +
        'separately because the tuning direction differs: loosening name-guard rescue widens a ' +
        'GUARD, loosening this widens which catalog row a photo request may FETCH — an operator ' +
        'must be able to tune one without silently moving the other.',
    }),
  num('INBOUND_PIN_SIMILARITY_THRESHOLD', 'float', 0.48, { min: 0, max: 1 }, 'frozen',
    'Min pg_trgm word_similarity for the inbound-name pinning trigram rung (typo recovery)', {
      rationale:
        'Same 2026-07-12 calibration as NAME_GUARD_SIMILARITY_THRESHOLD (typos 0.500-0.870, ' +
        'fabrications 0.143-0.467) but declared separately per house convention: loosening ' +
        'name-guard rescue widens a GUARD, loosening this widens which catalog rows a customer ' +
        'message can PIN into the retrieval pool. Note the trigram rung covers real typos only — ' +
        'Albanianized orthography (kreatinen↔Creatine scores ~0.36, inside the fabrication band) ' +
        'is handled by the deterministic dialect-variant rung, so do NOT lower this floor to ' +
        'chase those.',
    }),
  num('GUARD_CATALOG_CACHE_TTL_SECONDS', 'int', 120, { min: 1, max: 86_400 }, 'frozen',
    'TTL for the per-tenant guard reference sets (price set, name index, attribute index)', {
      rationale:
        'Also pre-existing and also a bare parseInt IIFE until P3-1. Shared by all three reference ' +
        'sets deliberately — correctness comes from invalidateProductCatalogCaches firing on every ' +
        'product mutation, not from the TTL, so independent per-set TTLs would add drift surface ' +
        'and buy nothing. The TTL only bounds how long a MISSED invalidation can persist. Note the ' +
        'staleness direction differs per set: for prices/names a stale entry can withhold a ' +
        'rescue; for the P3-1 attribute index it can additionally withhold SUPPORT, so a merchant ' +
        'who edits a description to add "pa sheqer" has a true claim contradictable for up to one ' +
        'TTL. Lower it before raising the attribute lane to enforce on a fast-editing tenant.',
    }),
  num('GROUNDING_ATTR_MAX_CLAIMS', 'int', 8, { min: 0, max: 64 }, 'frozen',
    'Max declared attribute claims judged per reply; the remainder are let through (P3-1)', {
      rationale:
        'Each DISTINCT product_ref can cost one pg_trgm round trip, on the send-path tail, inside ' +
        'the never-renewed AI_CONVERSATION_LOCK_TTL_MS (300s) and outside any OpenAI turn ' +
        'deadline. The json_schema does not bound the facts_used array, so a pathological ' +
        'completion is otherwise unbounded work. Overflow FAILS OPEN (extra claims are let ' +
        'through, never flagged), so this cap can only ever REDUCE flags. 0 disables judging ' +
        'without touching the mode enum — the fast in-incident kill switch.',
    }),
  num('GROUNDING_ATTR_INDEX_MAX_ROWS', 'int', 20_000, { min: 100, max: 200_000 }, 'frozen',
    'Row cap on the P3-1 attribute evidence index; hitting it disables CONTRADICTION entirely', {
      rationale:
        'A ROW cap, deliberately NOT a per-row character cap. A char cap looks like a tuning knob ' +
        'but is a correctness hazard with the wrong monotonicity: on the real row "Isolate ' +
        'protein 700gr qokolad" the text CONTRADICTING a lactose-free claim sits at char ~345 ' +
        'while the SUPPORTING text sits far later, so truncation keeps the contradiction and cuts ' +
        'the rescue — it MANUFACTURES flags. Real descriptions reach 3272 chars (avg ~800), so ' +
        'rows are stored untruncated and the index instead sets `truncated` when this cap is hit, ' +
        'which makes every claim contradiction-ineligible. Raising this can only reduce flags.',
    }),
  num('GROUNDING_ATTR_REF_SIMILARITY', 'float', 0.6, { min: 0.3, max: 1 }, 'frozen',
    "pg_trgm floor for resolving an attribute fact's product_ref to ONE catalog row (P3-1)", {
      rationale:
        'DECOUPLED from NAME_GUARD_SIMILARITY_THRESHOLD (0.48) because the safety DIRECTION is ' +
        'inverted. For names a LOW threshold RESCUES a suspect, i.e. produces fewer flags; here a ' +
        'low threshold resolves MORE refs to product scope — the only scope permitted to ' +
        'contradict — so lowering it INCREASES flag exposure. Sharing one knob would mean an ' +
        'operator loosening it to rescue heavier typos silently widens the attribute flag ' +
        'surface. 0.6 clears the empirically calibrated fabrication band (0.143-0.467) with ' +
        'margin. A resolution failure costs only recall: it falls back to tenant scope, which is ' +
        'rescue-only and can never flag.',
    }),
  num('FACTS_CONTRACT_MAX_TOKENS', 'int', 1200, { min: 256, max: 16_000 }, 'frozen',
    'max_tokens for the facts_used contract completion; truncation is a retryable failure (P2-1)'),
  num('SUMMARY_SLOT_BACKED_MAX_TAIL_CHARS', 'int', 600, { min: 1, max: 10_000 }, 'frozen',
    "Char cap on the slot-backed summary's extractive tail (P2-3)"),
  num('SEMANTIC_SKIPPED_ALERT_THRESHOLD', 'int', 20, { min: 0, max: 100_000 }, 'frozen',
    'Semantic-skip count within the window that fires ONE Sentry burst alert. 0 = off (P2-6/RC-04)'),
  num('SEMANTIC_SKIPPED_ALERT_WINDOW_SECONDS', 'int', 300, { min: 10, max: 86_400 }, 'frozen',
    'Rolling window (s) for the semantic-skip burst alert (P2-6/RC-04)'),
  num('PROMPT_GUIDELINES_MAX_CHARS', 'int', 20_000, { min: 1000, max: 200_000 }, 'frozen', 'Char budget for the assembled guideline blocks (P2-5)'),
  // P3-2 (C-125/RC-04): the two HNSW candidate-pool knobs were bare `parseInt(process.env...)` IIFEs
  // in db/models/product.ts, and HNSW_EF_SEARCH was DUPLICATED in productImageFingerprint.ts — two
  // copies that could already disagree. They are decision knobs, not infrastructure: they change
  // which products a customer is shown. Declaring them also removes an interpolation hazard —
  // `SET LOCAL hnsw.ef_search = ${n}` is string-built (a GUC is not bindable), so a NaN rendered
  // literally and threw inside the similarity query's own transaction.
  num('HNSW_EF_SEARCH', 'int', 100, { min: 1, max: 10_000 }, 'frozen',
    'HNSW candidate-pool size for the first similarity pass', {
      rationale:
        'The embedding index is GLOBAL and `tenant_id` is a POST-filter, so a small tenant\'s true ' +
        'matches can be crowded out of the pool by other tenants\' rows. pgvector\'s default (40) ' +
        'was too small for that; 100 is the measured floor. Always raised to at least the query ' +
        'LIMIT before use.',
    }),
  num('HNSW_EF_SEARCH_MAX', 'int', 500, { min: 1, max: 100_000 }, 'frozen',
    'Ceiling for the adaptive HNSW escalation on an under-filled first pass', {
      rationale:
        'Only reached when the first pass under-fills AND the tenant provably has more eligible ' +
        'rows than we hold (P3-2 fixed the missing second condition — see db/vectorSearchPolicy.ts). ' +
        'Superseded by VECTOR_ITERATIVE_SCAN where pgvector >= 0.8 is available.',
    }),
  num('PROMPT_ASSEMBLY_MAX_CHARS', 'int', 34_000, { min: 1000, max: 400_000 }, 'frozen', 'Char budget above which the assembled prompt is reported (P2-5)'),
  num('OPENAI_MAX_RETRIES', 'int', 3, { min: 0, max: 10 }, 'frozen', 'Retries for every OpenAI call'),
  num('OPENAI_TIMEOUT_MS', 'int', 60_000, { min: 1000, max: 600_000 }, 'frozen', 'Timeout for every OpenAI call'),

  // --- P2-6 (RC-19/RC-04): provider-failure isolation ----------------------------------------
  //
  // `OPENAI_TIMEOUT_MS` above is PER ATTEMPT, so with OPENAI_MAX_RETRIES=3 one call can occupy
  // 60s x 4 = 240s while holding the per-conversation lock (SPOF-3). These two caps bound the
  // WHOLE call and the whole turn. Both default 0 = OFF, so an env that sets neither behaves
  // exactly as it did before P2-6.
  num('OPENAI_CALL_TIMEOUT_MS', 'int', 0, { min: 0, max: 600_000 }, 'frozen',
    'Hard cap (ms) on a single OpenAI call INCLUDING the SDK retry chain. 0 = off', {
      rationale:
        '0 = kill switch rather than a separate PER_TURN_DEADLINE bool: a flag and a value that can ' +
        'disagree is exactly the drift class P2-7 exists to kill (same idiom as ' +
        'RETRIEVAL_NEG_CACHE_TTL_SECONDS=0). MUST NOT be enabled without GRACEFUL_DEGRADE_MODE: on ' +
        'its own, a cap shorter than a provider blip aborts the refund detector, the umbrella at ' +
        'processAIReply catches it, and a SALES reply ships to a refund demand — RC-19, but faster. ' +
        'The turn-level degrade gate is what makes this knob safe.',
    }),
  num('OPENAI_TURN_DEADLINE_MS', 'int', 0, { min: 0, max: 600_000 }, 'frozen',
    'Total OpenAI budget (ms) for one AI-reply turn, shared across its ~25 calls. 0 = off', {
      rationale:
        'Bounds the whole fan-out, not just one call. Rearmed (NOT cleared) before the send, so the ' +
        'post-send order-detection tail is bounded too — it runs inside the same try whose finally ' +
        'releases ai_conv_lock. NOTE the arithmetic: budget x2 (pre-send + rearmed tail) must stay ' +
        'under AI_CONVERSATION_LOCK_TTL_MS (300_000), which is never renewed. At 120_000 that is ' +
        '240s vs 300s — 60s of margin, and the SDK\'s non-abort-aware backoff sleeps eat into it.',
    }),
  {
    key: 'OPENAI_CIRCUIT_BREAKER',
    kind: 'enum',
    values: ['off', 'monitor', 'on'],
    requiredness: { kind: 'optional', default: 'off' },
    binding: 'per-call',
    description: 'OpenAI circuit breaker: off | monitor (count would-open, never fast-fail) | on (P2-6)',
    rationale:
      'monitor is the audit\'s mandated bake-in window: it records would-open transitions against a ' +
      'real provider without changing behaviour. Promote to `on` only after monitor shows a clean ' +
      'healthy-provider baseline, and only with GRACEFUL_DEGRADE_MODE already on.',
  },
  num('OPENAI_BREAKER_FAILURE_THRESHOLD', 'int', 5, { min: 1, max: 100 }, 'frozen',
    'Consecutive provider-availability failures before the breaker opens (P2-6)'),
  num('OPENAI_BREAKER_COOLDOWN_MS', 'int', 5_000, { min: 1000, max: 600_000 }, 'frozen',
    'How long the breaker fast-fails before admitting a half-open probe (P2-6)', {
      rationale:
        'DELIBERATELY below aiQueue\'s exponential backoff base (attempts:3, delay:10_000 ⇒ retries ' +
        'at T+10s and T+30s). A cooldown that spans the retry window makes every BullMQ attempt ' +
        'fast-fail without ever probing the provider, so the job exhausts and classifyJobFailure ' +
        'dead-letters it: a 30s blip would DLQ every in-flight reply. Keep this < 10_000, or raise ' +
        'aiQueue\'s backoff in the same change.',
    }),
  num('OPENAI_BREAKER_HALF_OPEN_PROBES', 'int', 1, { min: 1, max: 10 }, 'frozen',
    'Concurrent probes admitted while the breaker is half-open (P2-6)'),
  num('PORT', 'int', 8000, { min: 1, max: 65_535 }, 'boot', 'API listen port'),

  // --- Image-match policy (bare parseFloat before P2-7 — same NaN class as SIMILARITY_THRESHOLD)
  num('IMAGE_SIMILARITY_THRESHOLD', 'float', 0.62, { min: 0, max: 1 }, 'frozen', 'Min similarity for a customer photo to match a catalog product'),
  num('IMAGE_MATCH_CONFIDENCE_THRESHOLD', 'float', 0.55, { min: 0, max: 1 }, 'frozen', 'Min confidence to act on an image match'),
  num('VISION_EXTRACTION_CONFIDENCE_MIN', 'float', 0.35, { min: 0, max: 1 }, 'frozen', 'Min vision-extraction confidence'),
  num('IMAGE_MATCH_AMBIGUITY_DELTA', 'float', 0.04, { min: 0, max: 1 }, 'frozen', 'Score gap below which two image matches are ambiguous'),

  // --- P2-7's own controls -------------------------------------------------------------------
  {
    key: 'STRICT_CONFIG_VALIDATION',
    kind: 'enum',
    values: ['off', 'warn', 'strict'],
    requiredness: { kind: 'optional', default: 'warn' },
    binding: 'boot',
    description: 'Config-validation posture: off | warn (default) | strict',
    rationale:
      'Runtime boot NEVER exits on a band/parse violation regardless of this value — only ' +
      '`npm run config:check` (i.e. CI) escalates. See validateEnv.ts and scripts/checkConfig.ts.',
  },
  bool('CONFIG_FINGERPRINT_REGISTRY', false, 'Record this instance\'s config fingerprint in the config_fingerprints table at boot'),

  // --- Feature flags (P0-P2). Drift here changes outcome class, so they are fingerprinted. ---
  bool('REDACT_PII', true, 'Redact customer PII in logs and durable telemetry (P1-6)'),
  bool('STRUCTURED_LOGGING', false, 'JSON, correlation-keyed AI-path logs (P2-4)', { binding: 'per-call' }),
  bool('AI_DECISION_LEDGER_ENABLED', false, 'Write the per-reply AI decision ledger (P1-5/P2-4)'),
  bool('RECEIPT_TIME_SNAPSHOT', false, 'Capture gate/config state at receipt (P2-4 Part 2, record-only)'),
  bool('LEDGER_PROMPT_BLOBS', false,
    'Persist the full redacted system prompt content-addressed in ai_prompt_blobs (P2-4/§15.2)'),
  bool('WEBHOOK_DEDUPE_REPLAY', false, 'Accept late deliveries; replay via per-message key + DB dedupe (P2-4)'),
  bool('FACTS_USED_CONTRACT', false, 'Deterministic reply generation with a facts_used contract (P2-1)'),
  // P2-audit (P2-1-F2): binding corrected per-call -> frozen — the consumer reads it into a
  // module-load const (processAIReply), so per-call was a false read-lifetime claim.
  bool('GROUNDING_GATE_CONSOLIDATED', false, 'One consolidated grounding gate replacing the legacy guards (P2-1)'),
  {
    // P3-1 (RC-02/RC-03). An ENUM not a bool, following ORDER_STAGE_MACHINE / QUALITY_EVAL_MODE:
    // this is the first grounding dimension whose reference material is FREE PROSE rather than a
    // structurally complete set, so its false-positive rate has to be measured on live traffic
    // before it is allowed to act on a reply.
    key: 'GROUNDING_GATE_ATTRIBUTE_FACTS',
    kind: 'enum',
    values: ['off', 'shadow', 'enforce'],
    requiredness: { kind: 'optional', default: 'off' },
    binding: 'frozen',
    description:
      'Declared-attribute grounding lane: off | shadow (judge + ledger only) | enforce (P3-1). ' +
      'Meaningful only with GROUNDING_GATE_CONSOLIDATED=true and FACTS_USED_CONTRACT=true.',
    rationale:
      "Closes P3-1's named open gap — a false SENTENCE built from true WORDS, e.g. \"Mega mass " +
      '3kg Vanil eshte pa sheqer\" where the product and every token are real and only the ' +
      'proposition is invented. The lane flags ONLY CONTRADICTION: the resolved row\'s own text ' +
      'asserts the opposite. It deliberately does NOT flag SILENCE. Measured on the 257-row dev ' +
      'catalog, 218 rows say nothing about sugar and most supplements genuinely ARE sugar-free — ' +
      'the merchant simply never wrote it down — so "absent from the catalog" cannot be read as ' +
      '"false" here, and flagging silence would strip TRUE sentences at scale into a pause with ' +
      'no automatic exit. The gap\'s own acceptance product needs no silence rung: that row reads ' +
      '"Sheqer i reduktuar ... me e ulet ne sheqer", so the claim is refuted, not unsupported. ' +
      'Frozen, hence fingerprinted: two workers on different rungs would strip different replies ' +
      'from identical input — exactly the fleet-drift class the fingerprint registry detects.',
  },
  bool('GUARD_VALIDATE_AGAINST_FULL_CATALOG', false, 'Validate guards against the full active catalog (P0-2)', { binding: 'per-call' }),
  bool('GAP_GATE_DETERMINISTIC_FIRST', false, 'Gap gate escalates only on deterministic evidence (P0-3)', { binding: 'per-call' }),
  {
    key: 'GAP_FOCAL_PRODUCT_SCOPE',
    kind: 'enum',
    values: ['off', 'shadow', 'on'],
    requiredness: { kind: 'optional', default: 'off' },
    binding: 'per-call',
    description:
      'Scope the product-information gap machinery to the focal (inbound-named + variant-sibling) products: off | shadow (ledger-only) | on',
    rationale:
      'The gap availability checks, LLM assessor context and per-product missing pass run over the ' +
      'FULL fused retrieval window (10–25 products), not the products the customer asked about. ' +
      'Ledger evidence (conv e05575e2): a 2-product availability question retrieved 10 keyword ' +
      'matches (semantic count 0 at threshold 0.65), and one attribute-less same-category product ' +
      'then forced a "missing for at least one product" escalation onto a fully-answered question ' +
      '— the dominant product_question_unanswered false-positive class. When the turn has ' +
      'inbound-name pins, this scopes the gap set to pins + variant siblings ' +
      '(expandProductsForAttributeQuery); category-wide turns keep the full window. `shadow` ' +
      'records the would-be scope as a gap_scope ledger decision without changing behaviour.',
  },
  bool('SENSITIVE_PATH_FAIL_CLOSED', false, 'Sensitive-intent path fails closed (P0-4)', { binding: 'per-call' }),
  bool('RATE_LIMIT_COUNT_DELIVERED_ONLY', false, 'Count only delivered replies against the rate limit (P0-6/RC-18)', { binding: 'per-call' }),
  {
    key: 'ORDER_STAGE_MACHINE',
    kind: 'enum',
    values: ['off', 'shadow', 'on'],
    requiredness: { kind: 'optional', default: 'off' },
    binding: 'per-call',
    description: 'Deterministic order-stage FSM: off | shadow | on (P2-2)',
  },
  bool('MULTI_PRODUCT_ORDERS', false,
    'Register EVERY product from a multi-product order as its own order line (migration 088). Off ⇒ only the primary (first) product is recorded — the legacy single-product behaviour, byte-for-byte', {
      rationale:
        'The intent extractor now returns an items[] basket, but off this flag the order tail still ' +
        'creates one line from items[0] only, so a two-product order records one product — today\'s ' +
        'behaviour. On, the tail resolves and prices every item, merges duplicates, skips ' +
        'unresolvable/out-of-stock lines (registering the rest), sums the total and commissions on ' +
        'the sum. Frozen ⇒ fingerprinted: two workers on different values would register different ' +
        'baskets from identical input, exactly the fleet-drift class the registry detects.',
    }),
  {
    // P3-4 (RC-15). Enum, not a bool pair: the states are ordered and mutually exclusive, and two
    // independent booleans would admit a meaningless fourth combination. Mirrors the proven
    // ORDER_STAGE_MACHINE off|shadow|on shape.
    key: 'QUALITY_EVAL_MODE',
    kind: 'enum',
    values: ['enforce', 'shadow', 'off'],
    requiredness: { kind: 'optional', default: 'enforce' },
    binding: 'per-call',
    description: 'Reply quality eval: enforce | shadow (score + ledger only, no alert/pause) | off',
    rationale:
      'The eval is MISCALIBRATED and sits on the send path: it scores order confirmations a ' +
      'systematic 0.200 (EV-018) and a degenerate one-word "Po." scored 0.20 and shipped. At the ' +
      'live QUALITY_THRESHOLD=0.1 that is inert; at the 0.6 `.env.example` once shipped, every ' +
      'order confirmation would flag and PAUSE the AI at checkout with no auto-resume (RC-14). ' +
      'RC-15\'s fix is to move it OFF the send path, not to retune the floor. `shadow` is the ' +
      'parallel/log-only window: scores still reach the P1-5 ledger for the offline parity ' +
      'comparison, but nothing pauses. Default `enforce` keeps today\'s behaviour byte-identical.',
  },
  bool('COMMISSION_STORED_TIMESTAMP', false, 'Compute commission from stored timestamps, not NOW() (P2-2/RC-22)', { binding: 'per-call' }),
  bool('STICKY_LOCALE_SLOT', false, 'Sticky per-conversation reply locale (P2-2/RC-10)'),
  bool('INTENT_STRUCTURED_CONTRACT', false, 'Structured intent-classifier contract (P2-2)'),
  bool('HISTORY_DELIVERY_FILTERED', false, 'Exclude never-delivered/flagged replies from history (P2-3/RC-16)'),
  bool('SUMMARY_SLOT_BACKED', false, 'Slot-backed conversation summary (P2-3/RC-13)'),
  bool('AI_CONFIG_VERSIONED_CACHE', false, 'Versioned/CAS ai_config cache (P2-3/RC-17, C-55)'),
  bool('GHEG_LEXICONS', false, 'Gheg dialect lexicon forms (P2-5/RC-25)'),
  bool('DIALECT_NORMALIZATION', false, 'Unified dialect/diacritic normalization (P2-5)'),
  bool('RESTRICTIONS_FOOTER_ALL_TENANTS', false, 'Render the platform rulebook footer for every tenant (P2-5/RC-26)'),
  bool('PROMPT_ALLOWLIST_BUDGET', false, 'Allowlisted + token-budgeted prompt assembly (P2-5/RC-26)'),

  // --- P3-5 (RC-26/RC-25/RC-17): prompt versioning & governance ------------------------------
  bool('PROMPT_BLOCK_REGISTRY', false,
    'Record per-reply prompt-block versions + assembly outcome in the ledger (P3-5, migration 084)', {
      rationale:
        'Prompt content is the model\'s entire behavioural surface and had no history: catalog ' +
        'edits overwrote `default_content` with no record, and 19 prompt-mutating migrations have ' +
        'no inverse. This stamps the sha256 of every block AS STORED into ledger provenance, ' +
        'resolvable through prompt_block_versions. Flag-on adds two JSONB sub-objects to the ' +
        'existing `prompt` column and no schema change; the reply path never reads or writes the ' +
        'registry, so a hash unknown to it after a reconcile sweep is a real alarm rather than a ' +
        'race. Gates ONLY that ledger stamping: version registration itself (admin writes, the ' +
        'reconcile sweep) is unconditional, so prompt history accrues even with this off.',
    }),
  bool('PROMPT_ASSEMBLY_ALERTS', false,
    'Raise a deduped ai_alerts row on an orphan block key / required-section violation (P3-5/RC-26)', {
      rationale:
        'The allowlist already rejects the orphan, but only into a console.warn — which is how the ' +
        'orphan survived unnoticed in 6/6 tenants in the first place. Dedup is keyed on ' +
        '(tenant, kind, detail, catalog marker), NOT a TTL: the condition is structural, so one ' +
        'alert per catalog epoch is exactly right and it self-clears when the block is fixed.',
    }),
  bool('PROMPT_SELF_HEAL_OFF_HOT_PATH', false,
    'Skip the per-reply locked-block force-sync when the catalog marker is unchanged (P3-5)', {
      rationale:
        '`ensureTenantPromptBlocksSeeded` runs a COUNT plus an UPDATE...FROM join before EVERY ' +
        'generateReply. Flag-on loads first (the COUNT is redundant with rows.length) and consults ' +
        'a Redis catalog marker, so an unchanged catalog costs one GET and zero queries. A marker ' +
        'cache MISS counts as up-to-date deliberately — treating it as "needs sync" would ' +
        'force-sync the whole fleet on every cold start, which is the herd this removes. The ' +
        'reconcile sweep is what repairs a genuinely stale tenant.',
    }),
  num('PROMPT_REGISTRY_RECONCILE_INTERVAL_MS', 'int', 900_000, { min: 60_000, max: 86_400_000 }, 'frozen',
    'Cadence of the prompt-registry reconcile sweep (P3-5)', {
      rationale:
        'The sweep registers unregistered content, verifies stored hashes against a Node ' +
        'recomputation, and force-syncs drifted tenants. 15 min bounds how long a stale tenant ' +
        'waits once the per-reply force-sync is off, while staying far below any prompt-edit ' +
        'cadence a human produces.',
    }),
  {
    // Enum, not a bool: `shadow` is load-bearing. The item's own migration path says to measure the
    // prompt-size distribution from the ledger BEFORE cutting anything, and a bool cannot express
    // "compute what would drop, record it, change nothing" without a second flag. Mirrors the
    // proven GROUNDING_GATE_ATTRIBUTE_FACTS / ORDER_STAGE_MACHINE / QUALITY_EVAL_MODE shape.
    key: 'PROMPT_SECTION_BUDGET',
    kind: 'enum',
    values: ['off', 'shadow', 'enforce'],
    requiredness: { kind: 'optional', default: 'off' },
    binding: 'frozen',
    description:
      'Whole-prompt section budget: off | shadow (measure + record only) | enforce (P3-5/RC-26)',
    rationale:
      'RC-26: the system prompt is 26-33K chars and UNBUDGETED while only history is capped. ' +
      'P2-5 truncates the guideline blocks alone; the ceiling on the whole prompt reports and ' +
      'nothing more. Under `enforce`, PROMPT_ASSEMBLY_MAX_CHARS becomes the enforcing ceiling and ' +
      'sections are dropped by DECLARED priority. The injected product catalog is protected and ' +
      'never cut: the guards validate the reply against the FULL active catalog, so a product ' +
      'silently trimmed out of the prompt becomes "not available" in the reply while the guard ' +
      'passes it — RC-02, reintroduced through the budget.',
  },
  bool('ETA_STRIP_ALL_REPLIES', false,
    'Strip model-authored delivery ETAs from ordinary replies too, not just order confirmations (P3-5/RC-26, rule R10)', {
      binding: 'per-call',
      rationale:
        'R10 ("no delivery-time promises unless confirmed") was enforced only on ' +
        'classifier-detected order-confirmation turns, because the strip shared a function with ' +
        'the canonical-ETA INJECT. They are different jobs: only the inject belongs to ' +
        'confirmations. Flag-on runs the strip alone on other turns — a fabricated "arrives in 2 ' +
        'days" in a product or availability reply is a promise the business never made, and it is ' +
        'no less wrong for arriving on a non-confirmation turn. Never injects: volunteering an ETA ' +
        'unasked would be the opposite error.',
    }),
  bool('PRICE_INTENT_LEXICAL_UNION', false,
    'Treat an explicit price word in the customer message as price intent, without waiting for the classifier to agree (P3-5/RC-26, rules R4+R16)', {
      rationale:
        'The lexical keyword list already existed but was reachable ONLY when the LLM price ' +
        'classifier threw — so a confident `false` overrode a price word in plain sight. EV-010 ' +
        '(alert dcf5c812): "Me qfar shije i keni edhe sa kushtojn" — the classifier anchored on ' +
        'the flavour half while `kushtojn` sat in the list. Because `includePrice` is ' +
        '`customerAskedPrice || customerAskedDiscount`, a miss injects a catalog with NO price ' +
        'lines, the model cannot state a price, and the fail-closed gap assessor correctly reports ' +
        'missing_info:["çmimi"] and escalates. So R16 is not an assessor false positive to be ' +
        'filtered away — it is this, upstream. Flag-on can only ADD prices, only when the ' +
        'customer literally used a price word, and it skips the classifier call on those turns.',
    }),
  bool('UNCERTAIN_GUARD_CATALOG_ALTERNATIVES', false,
    'Key the uncertain-answer carve-out on the full active catalog, not this turn\'s retrieval window (P3-5/RC-25)', {
      // `frozen`, NOT `per-call`. GUARD_VALIDATE_AGAINST_FULL_CATALOG — the flag this one extends —
      // is declared per-call while actually being read into a module const, one of the ~8 binding
      // misdeclarations the P2 audit recorded. Copying its declaration would have made a ninth.
      // Binding documents the READ LIFETIME, and this is read once at module load.
      binding: 'frozen',
      rationale:
        'R6/R13 mandate "say it is unavailable, then suggest alternatives", and the guard escalates ' +
        'exactly that reply whenever retrieval happened to return nothing this turn — the guard\'s ' +
        'own doc comment says "the catalog contained alternatives" while the code says ' +
        '`matchedProducts.length > 0`. Flag-on additionally accepts "the reply named a product that ' +
        'exists in the full active catalog", the same full-catalog treatment P0-2 gave the price ' +
        'and name guards. Per-call to match GUARD_VALIDATE_AGAINST_FULL_CATALOG.',
    }),
  bool('AI_AUTO_RESUME', false, 'Automatic AI resume from eligible pauses (P0-5/RC-14)', { binding: 'per-call' }),
  bool('OUTBOX_RELAY_ENABLED', false, 'Transactional outbox relay (P1-1)'),
  bool('OUTBOX_DISPATCH_ENABLED', false, 'Outbox dispatch of staged side-effects (P1-1)'),
  bool('AI_REPLY_STAGE_BEFORE_SEND', false, 'Stage the reply row before sending (P1-1 idempotency)'),
  bool('INBOUND_OUTBOX_ENQUEUE', false,
    'Write the ai.reply intent transactionally with the message row instead of the racy debounce (P1-1/RC-05)',
    {
      rationale:
        'Declared in P3-2: it shipped with P1-1 as an inline process.env read documented only in ' +
        '.env.example, so it had no band validation, no boot report and no fingerprint coverage — ' +
        'while being one of the two flags that decide WHO creates the ai.reply job. Two instances ' +
        'disagreeing on it is a real split-brain: one persists an intent the other never dispatches. ' +
        'It replaces the getJobs/remove/add debounce (which does not scan `active`, removes at most ' +
        'one match, and is O(queue depth) per inbound) with the partial-unique-index upsert P1-1 ' +
        'already built. Only takes over delivery when OUTBOX_DISPATCH_ENABLED is also on — see ' +
        'services/inboundEnqueuePolicy.ts for why the half-on states keep the legacy enqueue.',
    }),
  bool('DLQ_ENABLED', false, 'Route exhausted jobs to the dead-letter queue (P1-2)', { binding: 'per-call' }),
  {
    // Enum rather than a bool because a third mode (e.g. shadow-compare) is a plausible next step,
    // and because it reads at the call site as the topology choice it is. Mirrors the proven
    // ORDER_STAGE_MACHINE / QUALITY_EVAL_MODE shape.
    key: 'AI_FAIRNESS_MODE',
    kind: 'enum',
    values: ['legacy', 'bounded'],
    requiredness: { kind: 'optional', default: 'legacy' },
    binding: 'frozen',
    description: 'Admission control for ai.reply: legacy (flat 3s re-add) | bounded (P3-2/C-79)',
    rationale:
      'The legacy path re-adds a starved job every 3s with NO jobId, so N jobs become N NEW jobs ' +
      'per tick with attemptsMade reset to 0 — an unbounded retry amplifier on the same queue the ' +
      'inbound debounce scans linearly per message. `bounded` adds a deterministic jobId (so ' +
      'concurrent deferrals collapse into one), exponential jittered backoff, a hop budget, and ' +
      'lease-based tenant slots that cannot go negative. Default legacy so the cutover is a flag.',
  },
  bool('SOCKET_CROSS_PROCESS_EMIT', false,
    'Publish socket events through Redis so a worker process can reach connected clients (P3-2)',
    {
      binding: 'frozen',
      rationale:
        'Declared here (unlike PROCESS_ROLE and the pool/concurrency vars) precisely BECAUSE it is ' +
        'not role-varying: both roles should carry the same value, so a divergence is real drift ' +
        'worth catching. socketService holds a module-local `io` attached only by the API, and every ' +
        'emit used to early-return on null with no log — so a worker would drop all ~87 of its emits ' +
        'silently. The inbox has NO polling backstop (query-client sets refetchOnWindowFocus:false ' +
        'and InboxPage sets no refetchInterval), so that reads to a merchant as a frozen inbox while ' +
        'the AI replies normally. PROCESS_ROLE=worker with this OFF is refused at boot.',
    }),
  bool('VECTOR_ITERATIVE_SCAN', false,
    'Use pgvector >= 0.8 iterative index scan instead of the adaptive ef_search retry (P3-2/RC-04)',
    {
      binding: 'per-call',
      rationale:
        'The upstream fix for ANN-plus-post-filter under-fill: the scan continues past ef_search ' +
        'until the LIMIT is satisfied or the index is exhausted, so it self-terminates for a small ' +
        'tenant AND recovers recall for a large one — strictly better than the two-shot retry. ' +
        'ALWAYS strict_order: partitionBySimilarityBand and the retrievalTop slice both assume ' +
        'strictly descending similarity, which relaxed_order does not guarantee. Gated because the ' +
        'capability is version-dependent and prod pins a ROLLING image tag; the flag is inert ' +
        'unless db/vectorCapability.ts probed support, since SETting an unknown hnsw.* GUC errors ' +
        'inside the similarity query\'s transaction and would take retrieval to zero.',
    }),
  bool('VECTOR_TENANT_PARTIAL_INDEX', false,
    'Maintain + use per-tenant partial HNSW indexes over products.embedding (P3-2/RC-04)',
    {
      binding: 'per-call',
      rationale:
        'The global HNSW index ranks ALL tenants\' vectors and post-filters by tenant, so a small ' +
        'tenant\'s true matches can be crowded out of the ef_search candidate pool by big tenants. ' +
        'Flag-on, a fleet-singleton sweep maintains a partial index per large tenant (CREATE INDEX ' +
        'CONCURRENTLY — runtime DDL, deliberately not a migration: the set is data-dependent), and ' +
        'the similarity query inlines the tenant UUID as a LITERAL for those tenants — a partial ' +
        'index predicate can never match a $1 parameter at plan time, so without inlining every ' +
        'per-tenant index is dead weight. The UUID is regex-validated before inlining; any doubt ' +
        'falls back to the parameterized global-index path.',
    }),
  num('VECTOR_PARTIAL_INDEX_MIN_ROWS', 'int', 2000, { min: 100, max: 1_000_000 }, 'per-call',
    'Embedded-row threshold above which a tenant earns its own partial HNSW index (P3-2)', {
      rationale:
        'Below this the global index + ef_search escalation serves recall fine and a dedicated ' +
        'index is pure write amplification (every embedding upsert maintains one more HNSW graph). ' +
        'Sized for the 5k-product tenant class; the 257-row dev tenant must NOT qualify. Indexes ' +
        'are dropped only below HALF this threshold (hysteresis), so a tenant hovering at the ' +
        'boundary does not churn CREATE/DROP INDEX CONCURRENTLY cycles.',
    }),
  num('VECTOR_PARTIAL_INDEX_MAX_TENANTS', 'int', 25, { min: 1, max: 500 }, 'per-call',
    'Cap on concurrent per-tenant partial vector indexes, largest tenants first (P3-2)', {
      rationale:
        'Each partial index is maintained on every qualifying products write. The cap bounds the ' +
        'fleet-wide write amplification; tenants beyond it stay on the global-index path, which ' +
        'remains correct — just less candidate-pool-isolated.',
    }),
  num('VECTOR_PARTIAL_INDEX_INTERVAL_MS', 'int', 21_600_000, { min: 60_000, max: 86_400_000 }, 'frozen',
    'Cadence of the per-tenant partial-index reconcile sweep (P3-2)', {
      rationale:
        'Catalog sizes move on human timescales (imports), so 6h bounds how long a newly-large ' +
        'tenant waits for its index while keeping CONCURRENTLY builds — minutes of background I/O ' +
        'each — rare. The sweep is a no-op when nothing crossed a threshold.',
    }),
  bool('GRACEFUL_DEGRADE_MODE', false,
    'One safe floor when the provider fails mid-turn: holding reply + escalate (P2-6/RC-19)',
    {
      binding: 'per-call',
      rationale:
        'The gate is TURN-level and reads a counter, not an exception — deliberately. ~21 classifiers ' +
        'catch any error into a fail-open default (classifySpeculativeHealthAdvice returns false) and ' +
        'the sensitive umbrella swallows the rest, so an exception-driven floor would be silently ' +
        'bypassed at ~22 sites. Enable this BEFORE (or with) OPENAI_CALL_TIMEOUT_MS / ' +
        'OPENAI_TURN_DEADLINE_MS / OPENAI_CIRCUIT_BREAKER=on, never after.',
    }),
  {
    // TEST-ONLY fault injection for the P2-6 outage validation, mirroring P0-4's
    // TEST_FORCE_DETECTOR_ERROR. `documented: false` keeps it out of `.env.example` — operators
    // copy that file to bootstrap a real env, and this must never appear there.
    key: 'TEST_FORCE_PROVIDER_ERROR',
    kind: 'enum',
    values: ['', 'timeout', 'unavailable', 'rate_limit'],
    requiredness: { kind: 'optional', default: '' },
    binding: 'frozen',
    documented: false,
    description: 'TEST-ONLY: force every OpenAI call to fail with this cause. Never set in production',
  },
];

const BY_KEY = new Map(KNOBS.map((k) => [k.key, k]));

export function knobSpec(key: string): KnobSpec | undefined {
  return BY_KEY.get(key);
}

// ---------------------------------------------------------------------------
// Reading.
// ---------------------------------------------------------------------------

export interface KnobReading {
  raw: string | undefined;
  /** The value actually in force (the default when absent/invalid). */
  value: string | number | boolean;
  usedDefault: boolean;
  parseOk: boolean;
  inBand: boolean;
}

function defaultOf(spec: KnobSpec): string | number | boolean {
  return spec.requiredness.kind === 'optional' ? spec.requiredness.default : '';
}

/**
 * Read + parse one knob from an env bag. Pure: no process.env, no throw, no log.
 *
 * The returned `value` is always the value the app will actually use, so callers can log the
 * EFFECTIVE value of every knob (guard 6) without duplicating each consumer's fallback logic —
 * the duplication that made `validateEnv` itself a drift source before P2-7.
 */
export function readKnob(spec: KnobSpec, env: NodeJS.ProcessEnv): KnobReading {
  const raw = env[spec.key]?.trim();
  const fallback = defaultOf(spec);

  if (raw === undefined || raw === '') {
    return { raw: undefined, value: fallback, usedDefault: true, parseOk: true, inBand: true };
  }

  switch (spec.kind) {
    case 'bool': {
      const lowered = raw.toLowerCase();
      if (lowered !== 'true' && lowered !== 'false') {
        return { raw, value: fallback, usedDefault: true, parseOk: false, inBand: true };
      }
      return { raw, value: lowered === 'true', usedDefault: false, parseOk: true, inBand: true };
    }
    case 'enum': {
      const lowered = raw.toLowerCase();
      const ok = (spec.values ?? []).includes(lowered);
      return { raw, value: ok ? lowered : fallback, usedDefault: !ok, parseOk: ok, inBand: true };
    }
    case 'int':
    case 'float': {
      const n = spec.kind === 'int' ? parseInt(raw, 10) : parseFloat(raw);
      if (!Number.isFinite(n)) {
        return { raw, value: fallback, usedDefault: true, parseOk: false, inBand: true };
      }
      const inBand = spec.band
        ? spec.band.exclusive
          ? n > spec.band.min && n < spec.band.max
          : n >= spec.band.min && n <= spec.band.max
        : true;
      // Out of band ⇒ we report it AND fall back, rather than honouring a value the consumer's own
      // guard would have rejected anyway. Reporting is the change; the fallback matches today.
      return { raw, value: inBand ? n : fallback, usedDefault: !inBand, parseOk: true, inBand };
    }
    default:
      return { raw, value: raw, usedDefault: false, parseOk: true, inBand: true };
  }
}

/**
 * Typed accessor for a numeric knob — the consumer-facing entry point.
 *
 * This replaces the ad-hoc `parseFloat(process.env.X || '0.65')` / IIFE-with-clamp expressions that
 * were duplicated across ~75 files. Consumers get the manifest's parse + band + default for free,
 * so a knob can no longer be NaN-guarded in one file and unguarded in the next (the defect that let
 * a typo'd SIMILARITY_THRESHOLD silently disable semantic retrieval fleet-wide).
 *
 * Throws only on a programming error (unknown key / wrong kind), never on bad env — bad env is the
 * manifest's job to report, not this function's to crash on.
 */
export function knobNumber(key: string, env: NodeJS.ProcessEnv = process.env): number {
  const spec = mustSpec(key);
  if (spec.kind !== 'int' && spec.kind !== 'float') {
    throw new Error(`knobNumber(${key}): declared as ${spec.kind}, not a number`);
  }
  return readKnob(spec, env).value as number;
}

/** Typed accessor for a boolean knob. */
export function knobBool(key: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const spec = mustSpec(key);
  if (spec.kind !== 'bool') throw new Error(`knobBool(${key}): declared as ${spec.kind}, not a bool`);
  return readKnob(spec, env).value as boolean;
}

/** Typed accessor for a string/enum knob. */
export function knobString(key: string, env: NodeJS.ProcessEnv = process.env): string {
  const spec = mustSpec(key);
  return String(readKnob(spec, env).value);
}

function mustSpec(key: string): KnobSpec {
  const spec = BY_KEY.get(key);
  if (!spec) throw new Error(`knob "${key}" is not declared in config/knobs.ts`);
  return spec;
}

// ---------------------------------------------------------------------------
// Detection (severity-free) + mode application (severity assignment).
// ---------------------------------------------------------------------------

export type Severity = 'fatal' | 'warn' | 'info';

export type FindingCode =
  /** Set, parses, in band — nothing wrong. Reported so guard 6 can log every knob's value. */
  | 'ok'
  | 'required_missing'
  | 'unparseable'
  | 'out_of_band'
  | 'unknown_enum'
  /** Absent, using the manifest default. Can NEVER be more than info — P2-7's stated edge case. */
  | 'optional_defaulted'
  | 'dimension_mismatch'
  | 'unknown_model'
  | 'secret_weak'
  | 'secret_duplicate';

export interface Finding {
  key: string;
  code: FindingCode;
  message: string;
  /** The value actually in force. `null` for secrets and for missing required vars. */
  effective: string | null;
  severity?: Severity;
}

export type Mode = 'off' | 'warn' | 'strict';

export function resolveMode(env: NodeJS.ProcessEnv): Mode {
  const raw = env.STRICT_CONFIG_VALIDATION?.trim().toLowerCase();
  return raw === 'off' || raw === 'warn' || raw === 'strict' ? raw : 'warn';
}

const MIN_SECRET_LENGTH = 32;
const STRENGTH_CHECKED = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'ADMIN_JWT_SECRET', 'ADMIN_KEY'];

const RECOMMENDED: ReadonlyArray<{ key: string; description: string }> = [
  { key: 'ENCRYPTION_KEY', description: 'AES key for channel access-token encryption' },
  { key: 'ADMIN_JWT_SECRET', description: 'Signing secret for platform-admin tokens' },
  { key: 'WEBHOOK_VERIFY_TOKEN', description: 'Meta webhook subscription verify token' },
  { key: 'META_APP_SECRET', description: 'Meta app secret for webhook signature checks' },
];

/**
 * Inspect an env bag and report what is wrong (or merely defaulted) with it.
 *
 * Deliberately severity-FREE: whether "INTENT_THRESHOLD=7" is fatal depends on WHERE we are
 * (a running container vs. CI), not on WHAT is wrong. Keeping the two apart means `applyMode` is a
 * pure lookup table that can be unit-tested exhaustively, and the same detector serves boot and CI.
 */
export function detect(env: NodeJS.ProcessEnv, knobs: readonly KnobSpec[] = KNOBS): Finding[] {
  const findings: Finding[] = [];

  for (const spec of knobs) {
    const reading = readKnob(spec, env);
    const shown = spec.secret ? null : String(reading.value);

    if (reading.raw === undefined) {
      if (spec.requiredness.kind === 'required') {
        findings.push({ key: spec.key, code: 'required_missing', effective: null, message: `${spec.key} (${spec.description}) is missing` });
      } else if (spec.requiredness.kind === 'required-in-production') {
        findings.push({ key: spec.key, code: 'required_missing', effective: null, message: `${spec.key} (${spec.description}) is not set` });
      } else {
        findings.push({ key: spec.key, code: 'optional_defaulted', effective: shown, message: `${spec.key}=${shown} (default)` });
      }
      continue;
    }

    if (!reading.parseOk) {
      findings.push({
        key: spec.key,
        code: spec.kind === 'enum' ? 'unknown_enum' : 'unparseable',
        effective: shown,
        message:
          spec.kind === 'enum'
            ? `${spec.key}="${reading.raw}" is not one of [${(spec.values ?? []).join(', ')}]; using ${shown}`
            : `${spec.key}="${reading.raw}" is not a valid ${spec.kind}; using ${shown}`,
      });
      continue;
    }

    if (!reading.inBand && spec.band) {
      // Render an exclusive band as `(min, max)` rather than `[min, max]` — otherwise the message
      // for INTENT_THRESHOLD=1 reads "1 is outside the supported range [0, 1]", which looks like a
      // bug in the checker rather than the point being made.
      const range = spec.band.exclusive
        ? `greater than ${spec.band.min} and less than ${spec.band.max} (exclusive)`
        : `within [${spec.band.min}, ${spec.band.max}]`;
      findings.push({
        key: spec.key,
        code: 'out_of_band',
        effective: shown,
        message: `${spec.key}=${reading.raw} is not ${range}; using ${shown}`,
      });
      continue;
    }

    findings.push({ key: spec.key, code: 'ok', effective: shown, message: `${spec.key}=${shown}` });
  }

  findings.push(...detectEmbeddingDimension(env));
  findings.push(...detectSecretHygiene(env));

  return findings;
}

/**
 * Guard 1's offline half (RC-04). The embedding model must emit vectors that fit the
 * `vector(1536)` columns; `scripts/checkConfig.ts` additionally verifies the real column dimension.
 */
export function detectEmbeddingDimension(env: NodeJS.ProcessEnv): Finding[] {
  const model = resolveModel('embedding', { env });
  if (!model) return []; // `required_missing` already covers the unset case.

  const dim = EMBEDDING_MODEL_DIMS[model];
  if (dim === undefined) {
    return [{
      key: 'OPENAI_EMBEDDING_MODEL',
      code: 'unknown_model',
      effective: model,
      message: `OPENAI_EMBEDDING_MODEL=${model} has an unknown output dimension; ensure it matches the vector(${EXPECTED_EMBEDDING_DIM}) embedding columns`,
    }];
  }
  if (dim !== EXPECTED_EMBEDDING_DIM) {
    return [{
      key: 'OPENAI_EMBEDDING_MODEL',
      code: 'dimension_mismatch',
      effective: model,
      message:
        `OPENAI_EMBEDDING_MODEL=${model} produces ${dim}-dim vectors, but the embedding columns are ` +
        `vector(${EXPECTED_EMBEDDING_DIM}); every similarity query would error. Use a ${EXPECTED_EMBEDDING_DIM}-dim ` +
        'model (e.g. text-embedding-3-small), or run a reindex migration first.',
    }];
  }
  return [];
}

function detectSecretHygiene(env: NodeJS.ProcessEnv): Finding[] {
  const findings: Finding[] = [];

  for (const { key, description } of RECOMMENDED) {
    if (!env[key]?.trim()) {
      findings.push({ key, code: 'required_missing', effective: null, message: `${key} (${description}) is not set` });
    }
  }

  for (const key of STRENGTH_CHECKED) {
    const value = env[key]?.trim();
    if (value && value.length < MIN_SECRET_LENGTH) {
      findings.push({ key, code: 'secret_weak', effective: null, message: `${key} is shorter than ${MIN_SECRET_LENGTH} characters (low entropy)` });
    }
  }

  const jwt = env.JWT_SECRET?.trim();
  const refresh = env.JWT_REFRESH_SECRET?.trim();
  if (jwt && refresh && jwt === refresh) {
    findings.push({
      key: 'JWT_SECRET',
      code: 'secret_duplicate',
      effective: null,
      message: 'JWT_SECRET and JWT_REFRESH_SECRET are identical; refresh and access tokens must use distinct secrets',
    });
  }

  return findings;
}

/** Codes that abort the boot in EVERY mode. Everything else can only warn at runtime. */
const ALWAYS_FATAL: ReadonlySet<FindingCode> = new Set<FindingCode>(['required_missing', 'dimension_mismatch']);

/** Codes a strict run (CI) escalates to fatal. */
const STRICT_FATAL: ReadonlySet<FindingCode> = new Set<FindingCode>(['unparseable', 'out_of_band', 'unknown_enum']);

/**
 * Assign a severity to each finding. Pure table lookup — the whole matrix is unit-tested.
 *
 * Note `optional_defaulted` can NEVER exceed `info`, in any mode. That is P2-7's stated edge case:
 * warn-only must distinguish "required and missing" (fail) from "optional, using default" (info).
 * Because requiredness is a structural property of the spec, this cannot be got wrong by wording.
 */
export function applyMode(findings: Finding[], mode: Mode, isProd: boolean): Finding[] {
  return findings.map((f) => ({ ...f, severity: severityOf(f, mode, isProd) }));
}

function severityOf(f: Finding, mode: Mode, isProd: boolean): Severity {
  if (f.code === 'ok' || f.code === 'optional_defaulted') return 'info';

  // RECOMMENDED secrets report as required_missing but are advisory — they are not in KNOBS, so
  // distinguish them by membership rather than by code.
  const isRecommended = RECOMMENDED.some((r) => r.key === f.key);
  if (f.code === 'required_missing' && isRecommended) return 'warn';

  if (ALWAYS_FATAL.has(f.code)) return 'fatal';

  // Weak/duplicate signing secrets undermine token integrity — fatal in production, advisory in dev
  // so local setups are not blocked (pre-P2-7 behaviour, preserved).
  if (f.code === 'secret_weak' || f.code === 'secret_duplicate') return isProd ? 'fatal' : 'warn';

  if (mode === 'off') return 'info';
  if (mode === 'strict' && STRICT_FATAL.has(f.code)) return 'fatal';
  return 'warn';
}

// ---------------------------------------------------------------------------
// `.env.example` drift (guard 6's documentation half). CI-only — never a boot concern.
// ---------------------------------------------------------------------------

/**
 * Parse a `.env.example`. Commented-out assignments (`# FLAG=true`) count as DOCUMENTED — that is
 * the file's house style for optional flags — but only an uncommented line is an ACTIVE value whose
 * literal can be compared against the manifest default.
 */
export function parseEnvExample(text: string): {
  documented: Set<string>;
  active: Map<string, string>;
} {
  const documented = new Set<string>();
  const active = new Map<string, string>();

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const match = /^(#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;
    const [, commented, key, rawValue] = match;
    documented.add(key);
    if (!commented) active.set(key, rawValue.trim());
  }
  return { documented, active };
}

export type ExampleFindingCode = 'undocumented' | 'default_mismatch';

export interface ExampleFinding {
  key: string;
  code: ExampleFindingCode;
  message: string;
}

/**
 * Compare `.env.example` against the manifest.
 *
 * Two failures matter, and both were real when P2-7 started: 47 knobs were read by the code but
 * absent from the example (so an env bootstrapped from it silently used code defaults an operator
 * never saw — including AI_REPLY_TEMPERATURE and INTENT_THRESHOLD), and the example shipped values
 * that DISAGREED with the code (QUALITY_THRESHOLD=0.6 vs 0.1, PORT=8000 vs 3000). The second class
 * is the more dangerous: it makes the example a trap rather than merely incomplete.
 *
 * Deliberately one-directional. This checks that the manifest is documented, not that the example
 * is minimal — the example legitimately carries infrastructure keys (Backblaze, Cloudinary, cron
 * expressions) the manifest does not enumerate, so "in the example but not in the manifest" is not
 * an error.
 */
export function detectExampleDrift(
  exampleText: string,
  knobs: readonly KnobSpec[] = KNOBS,
): ExampleFinding[] {
  const { documented, active } = parseEnvExample(exampleText);
  const findings: ExampleFinding[] = [];

  for (const spec of knobs) {
    if (spec.documented === false) continue;

    if (!documented.has(spec.key)) {
      findings.push({
        key: spec.key,
        code: 'undocumented',
        message: `${spec.key} is read by the code but absent from .env.example (${spec.description})`,
      });
      continue;
    }

    const activeValue = active.get(spec.key);
    if (activeValue === undefined || spec.requiredness.kind !== 'optional') continue;

    const expected = String(spec.requiredness.default);
    // Synthetic "(OPENAI_CHAT_MODEL)" style defaults describe a fallback CHAIN, not a literal, so
    // there is nothing for the example to match.
    if (expected.startsWith('(')) continue;
    // An empty assignment (`JWT_SECRET=`) is a placeholder for the operator to fill, not a default.
    if (activeValue === '') continue;

    if (activeValue !== expected) {
      findings.push({
        key: spec.key,
        code: 'default_mismatch',
        message: `.env.example ships ${spec.key}=${activeValue} but the code default is ${expected} — an env built from the example would behave differently from one that omits the key`,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Guard 7 — the config fingerprint.
// ---------------------------------------------------------------------------

export interface ConfigFingerprint {
  /** Short sha256 over the manifest knob set. Two instances disagreeing ⇒ a drifted fleet. */
  hash: string;
  /** host:pid — which instance reported this config. */
  instance: string;
  knobs: Record<string, string | number | boolean>;
}

function shouldFingerprint(spec: KnobSpec): boolean {
  return spec.fingerprint ?? true;
}

/**
 * Fingerprint EVERY manifest knob (RC-06's "startup assertion that all instances read identical
 * env" — for all of them, not a subset).
 *
 * P2-audit (P2-7-F3/F4) correction: this originally hashed only `frozen` knobs, on the rationale
 * that "a per-call knob legitimately differs between two reads of the same process" — which is
 * false for env-backed knobs: `process.env` is boot-static, so a per-call read returns the same
 * value for the life of the process, and CROSS-INSTANCE disagreement on a per-call knob (two
 * workers with different AI_MAX_REPLIES_PER_HOUR or QUALITY_THRESHOLD — the spec's own
 * drift-acceptance scenario) is exactly as real as drift on a frozen one. `binding` documents
 * READ lifetime, not mutability, and no longer affects fingerprint coverage; `fingerprint: false`
 * on a spec remains the explicit opt-out. Secrets contribute a hash of their value, never the
 * value — a rotated secret must still show as drift, but the fingerprint is written to a database
 * and logs.
 */
export function fingerprint(env: NodeJS.ProcessEnv, instance = defaultInstanceId()): ConfigFingerprint {
  const knobs: Record<string, string | number | boolean> = {};

  for (const spec of KNOBS) {
    if (!shouldFingerprint(spec)) continue;
    const reading = readKnob(spec, env);
    knobs[spec.key] = spec.secret
      ? `sha256:${createHash('sha256').update(String(reading.value)).digest('hex').slice(0, 12)}`
      : reading.value;
  }

  // Sort so the hash is a function of the VALUES, not of declaration/insertion order.
  const canonical = Object.keys(knobs)
    .sort()
    .map((k) => `${k}=${String(knobs[k])}`)
    .join('\n');

  return {
    hash: createHash('sha256').update(canonical).digest('hex').slice(0, 16),
    instance,
    knobs,
  };
}

function defaultInstanceId(): string {
  // Lazy require keeps this module importable where `os` is unavailable (and leaf-pure).
  const host = process.env.HOSTNAME || require('node:os').hostname();
  // P3-2: the role leads the id. After the worker split, an API process and a worker process share
  // a hostname on the same box, so `host:pid` alone made the two indistinguishable in
  // `config_fingerprints` — and "which ROLE is the drifted one" is the first question anyone asks
  // when `count(DISTINCT hash) > 1` fires. Reading PROCESS_ROLE directly (rather than importing
  // config/processRole) keeps this module a dependency-free leaf; an unset value yields `all`,
  // matching that module's default.
  const role = (process.env.PROCESS_ROLE ?? 'all').trim().toLowerCase() || 'all';
  return `${role}@${host}:${process.pid}`;
}

/** The short form carried on every ledger row — a pointer into config_fingerprints. */
export function fingerprintRef(fp: ConfigFingerprint): { hash: string; instance: string } {
  return { hash: fp.hash, instance: fp.instance };
}

/** Every key the manifest knows about — used by the `.env.example` drift check. */
export function manifestKeys(): string[] {
  return [...new Set([...KNOBS.map((k) => k.key), ...modelEnvKeys()])];
}
