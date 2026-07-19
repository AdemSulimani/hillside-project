/**
 * Boot-time configuration validation.
 *
 * P2-7 (RC-15/RC-04/RC-06/RC-17) rebuilt this file as a thin DRIVER over `config/knobs.ts`. It used
 * to hand-roll every check inline and re-read env with its own duplicated default literals inside
 * the posture log strings (`?? '90'`, `?? '8000'`, `?? '20000'`) — so the validator was itself a
 * config-drift source. Every value below now comes from the manifest, which is the single place a
 * default is written down.
 *
 * THE RUNTIME POSTURE, AND WHY IT IS NOT A FLAG.
 * P2-7's sharp edge is that "a strict assertion WILL refuse to start a mis-set deploy" — intended
 * for CI, catastrophic for a running fleet, where it converts a silently-degraded-but-serving
 * container into a hard outage on the next restart. So the escalation is not a flag value, it is a
 * different PROGRAM:
 *
 *   - THIS function (runtime boot) caps its fatal set at {required_missing, dimension_mismatch,
 *     production-secret hygiene} regardless of STRICT_CONFIG_VALIDATION. A band/parse violation
 *     always warns loudly and STARTS. Implemented by capping the mode at 'warn' below.
 *   - `scripts/checkConfig.ts` (i.e. CI, via `npm run config:check`) runs the SAME detector in
 *     strict mode and exits(1) on any violation. That is where "a PR reintroducing a drift → red"
 *     lives, with no runtime blast radius.
 *
 * The pre-existing fatals (P1-4's embedding-dimension guard, P1-6's production secret hygiene) are
 * deliberately NOT weakened — downgrading them would be a safety regression. `ci.yml` carries the
 * scar proving the dimension fatal bites correctly.
 */
import {
  type Finding,
  type Mode,
  KNOBS,
  applyMode,
  detect,
  fingerprint,
  knobSpec,
  readKnob,
  resolveMode,
} from './knobs';
import { REDACT_PII } from '../utils/redact';
// Import-safe: providerResilience is a leaf (its only import is node:async_hooks), so this stays
// reachable from `scripts/checkConfig.ts`, which runs with no API key and no client construction.
import {
  AI_QUEUE_BACKOFF_BASE_MS,
  breakerCooldownOutrunsRetries,
  turnDeadlineOutrunsLock,
  enforcementWithoutFloor,
  type BreakerMode,
  type ProviderPosture,
} from '../services/providerResilience';

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Effective value of a manifest knob — the value the app will actually use. */
function eff(key: string): string {
  const spec = knobSpec(key);
  if (!spec) return String(process.env[key] ?? '');
  return String(readKnob(spec, process.env).value);
}

/** Effective value of a boolean manifest knob. */
function flag(key: string): boolean {
  return eff(key) === 'true';
}

/**
 * Human-readable report of a findings list. Shared with `scripts/checkConfig.ts` so the boot log
 * and the CI output cannot describe the same misconfiguration differently.
 */
export function formatFindings(findings: Finding[]): {
  fatal: string[];
  warnings: string[];
  info: string[];
} {
  const fatal: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];
  for (const f of findings) {
    if (f.severity === 'fatal') fatal.push(`  - ${f.message}`);
    else if (f.severity === 'warn') warnings.push(`  - ${f.message}`);
    else info.push(f.message);
  }
  return { fatal, warnings, info };
}

/**
 * Validates configuration required for a safe boot. Call from `bootstrap.ts` before importing the
 * Express app.
 *
 * Behaviour:
 *  - Missing REQUIRED config always aborts the boot.
 *  - A wrong-dimension embedding model always aborts (it would silently disable semantic retrieval
 *    fleet-wide — RC-04).
 *  - In production, weak/duplicated signing secrets abort; in development they only warn so local
 *    setups are not blocked.
 *  - Everything else (out-of-band thresholds, unparseable numbers, unknown enums) WARNS LOUDLY and
 *    starts. `npm run config:check` is the gate that fails.
 */
export function validateRequiredEnv(): void {
  const mode = resolveMode(process.env);

  // The cap that makes a pre-existing drift unable to take down a running fleet: runtime boot never
  // runs in strict. `off` still suppresses band warnings for operators who want the old silence.
  const runtimeMode: Mode = mode === 'strict' ? 'warn' : mode;

  const findings = applyMode(detect(process.env), runtimeMode, isProduction());
  const { fatal, warnings } = formatFindings(findings);

  logEffectiveKnobs(mode);
  logPosture();

  if (warnings.length > 0) {
    console.warn('[env] Configuration warnings:\n' + warnings.join('\n'));
    if (mode === 'strict') {
      console.warn(
        '[env] STRICT_CONFIG_VALIDATION=strict does NOT fail a runtime boot by design — a mis-set ' +
          'deploy must not become an outage. Run `npm run config:check --strict` in CI/pre-deploy to ' +
          'turn these into a hard failure.',
      );
    }
  }

  if (fatal.length > 0) {
    console.error('[env] Refusing to start due to invalid configuration:\n' + fatal.join('\n'));
    console.error('[env] Fix these in your environment or .env file, then restart the server.');
    process.exit(1);
  }
}

/**
 * Guard 6 + guard 7: log the boot config posture — the fingerprint over the module-load-frozen
 * subset, plus the effective value of every knob OVERRIDDEN from its default (a default-valued
 * knob's effective value is implied by the manifest and deliberately not spammed into the boot
 * log; the full per-knob effective view lives in `npm run config:check --json`).
 *
 * RC-06's regression-prevention text asks for "a startup assertion that all instances read
 * identical env for the frozen-at-load knobs". A single instance cannot assert that alone — so it
 * publishes its fingerprint, and any two instances disagreeing is the drift. This log line is the
 * always-on layer (no flag, no DB); `CONFIG_FINGERPRINT_REGISTRY` adds the queryable table.
 */
function logEffectiveKnobs(mode: Mode): void {
  const fp = fingerprint(process.env);
  console.info(
    `[config] fingerprint=${fp.hash} instance=${fp.instance} knobs=${Object.keys(fp.knobs).length} mode=${mode}` +
      ` (two instances reporting different fingerprints = a drifted fleet)`,
  );

  const nonDefault: string[] = [];
  for (const spec of KNOBS) {
    if (spec.secret) continue;
    const reading = readKnob(spec, process.env);
    if (!reading.usedDefault && reading.raw !== undefined) {
      nonDefault.push(`${spec.key}=${String(reading.value)}`);
    }
  }
  console.info(
    `[config] ${KNOBS.length} knobs declared; ${nonDefault.length} overridden from default: ` +
      (nonDefault.length > 0 ? nonDefault.join(' ') : '(none — all defaults)'),
  );
}

/** The per-phase posture blocks. Informational — never fatal. Values come from the manifest. */
function logPosture(): void {
  // P1-6 (SEC-5): redaction is ON by default and is the compliance boundary for customer PII in
  // logs and durable telemetry. Disabling it re-exposes cleartext PII and must be a deliberate,
  // compliance-owned decision — so surface it loudly at boot rather than silently.
  if (!REDACT_PII) {
    console.warn(
      '[REDACT_PII] DISABLED — customer PII (names/phones/addresses/health context) will be ' +
        'logged and stored in cleartext. This must be a deliberate, compliance-gated choice. ' +
        'Unset REDACT_PII (or set it to true) to re-enable redaction.',
    );
  }

  // P2-4 Part 1: how logs are shaped and whether the decision ledger is recording.
  const decisionLedger = flag('AI_DECISION_LEDGER_ENABLED');
  console.info(
    `[observability] STRUCTURED_LOGGING=${flag('STRUCTURED_LOGGING') ? 'on (JSON, correlation-keyed)' : 'off (legacy console)'}; ` +
      `AI_DECISION_LEDGER_ENABLED=${
        decisionLedger ? `on (retention ${eff('LEDGER_RETENTION_DAYS')}d)` : 'off (no rows written; retention sweep idle)'
      }; REDACT_PII=${REDACT_PII ? 'on' : 'off'}`,
  );

  // P2-4 Part 2: the receipt-snapshot + dedupe-replay posture.
  const receiptSnapshot = flag('RECEIPT_TIME_SNAPSHOT');
  const versionedCache = flag('AI_CONFIG_VERSIONED_CACHE');
  console.info(
    `[receipt] RECEIPT_TIME_SNAPSHOT=${
      receiptSnapshot ? 'on (captured at receipt; gates stay LIVE — record-only)' : 'off (no capture; gates live as always)'
    }; WEBHOOK_DEDUPE_REPLAY=${
      flag('WEBHOOK_DEDUPE_REPLAY') ? 'on (late deliveries accepted; replay = per-message key + DB dedupe)' : 'off (legacy 300s skew 403)'
    }; AI_REPLY_DELAY_MS=${eff('AI_REPLY_DELAY_MS')}` +
      // The RC-17 staleness floor is the snapshot's only GOVERNING use, and it can only act on the
      // versioned cache — the legacy EX900 value carries no version to compare. Say so, rather than
      // letting an operator believe RC-17 is covered when the floor is silently inert.
      `${receiptSnapshot && !versionedCache ? ' [RC-17 staleness floor INERT: needs AI_CONFIG_VERSIONED_CACHE=true]' : ''}`,
  );

  // P2-1: whether the deterministic gate + facts_used contract are live.
  const factsContract = flag('FACTS_USED_CONTRACT');
  const groundingGate = flag('GROUNDING_GATE_CONSOLIDATED');
  console.info(
    `[grounding] FACTS_USED_CONTRACT=${factsContract ? 'on (temp0+seed+json_schema)' : 'off (legacy temp/free-prose)'}; ` +
      `GROUNDING_GATE_CONSOLIDATED=${groundingGate ? 'on (consolidated gate)' : 'off (legacy price/name/gap guards)'}` +
      `${factsContract && !groundingGate ? ' [SHADOW: declared facts logged, legacy guards decide]' : ''}`,
  );
  // P2-7 (RC-03): say plainly when the reply is stochastic. The temperature default is 0.3 and the
  // seed is only sent on the contract path, so flag-off generation is NOT reproducible — live-replay
  // measured up to 8 distinct replies for one fixed input. Operators kept reading the old
  // "resolves the same way every time" comment and concluding otherwise.
  if (!factsContract) {
    console.info(
      `[grounding] reply sampling: temperature=${eff('AI_REPLY_TEMPERATURE')}, seed=(not sent) — identical input may ` +
        'yield different replies (RC-03). Set FACTS_USED_CONTRACT=true for temp 0 + fixed seed.',
    );
  }
  // P3-1: the attribute lane is wired inside the consolidated gate and reads declared facts, so
  // without BOTH prerequisites the mode knob is silently inert — a dead guard that looks green.
  const attributeMode = eff('GROUNDING_GATE_ATTRIBUTE_FACTS');
  if (attributeMode !== 'off' && (!groundingGate || !factsContract)) {
    console.warn(
      `[grounding] GROUNDING_GATE_ATTRIBUTE_FACTS=${attributeMode} but ` +
        `${groundingGate ? '' : 'GROUNDING_GATE_CONSOLIDATED=false '}${
          groundingGate || factsContract ? '' : 'and '
        }${factsContract ? '' : 'FACTS_USED_CONTRACT=false '}— the attribute lane never runs: ` +
        'no verdicts, no shadow evidence, no enforcement. Enable both prerequisites or set the lane to off.',
    );
  }
  if (attributeMode === 'shadow' && !flag('AI_DECISION_LEDGER_ENABLED')) {
    console.warn(
      '[grounding] GROUNDING_GATE_ATTRIBUTE_FACTS=shadow with AI_DECISION_LEDGER_ENABLED=false — ' +
        'shadow verdicts are computed but never persisted, so the bake-in window accrues no evidence ' +
        'for the enforce decision. Enable the ledger for the shadow period.',
    );
  }

  // P2-2: classifier consolidation.
  const orderStageMode = eff('ORDER_STAGE_MACHINE');
  console.info(
    `[classifiers] ORDER_STAGE_MACHINE=${
      orderStageMode === 'on'
        ? 'on (deterministic FSM authoritative; order LLM classifiers skipped)'
        : orderStageMode === 'shadow'
          ? 'shadow (FSM computed + divergence logged; legacy decides)'
          : 'off (legacy LLM order-classifiers)'
    }; STICKY_LOCALE_SLOT=${flag('STICKY_LOCALE_SLOT') ? 'on' : 'off'}; ` +
      `INTENT_STRUCTURED_CONTRACT=${flag('INTENT_STRUCTURED_CONTRACT') ? 'on' : 'off'}; ` +
      `COMMISSION_STORED_TIMESTAMP=${flag('COMMISSION_STORED_TIMESTAMP') ? 'on' : 'off'}`,
  );

  // P2-3: memory/history redesign.
  console.info(
    `[memory] HISTORY_DELIVERY_FILTERED=${
      flag('HISTORY_DELIVERY_FILTERED') ? 'on (drop send-failed; flagged/holding→system)' : 'off (legacy binary role map)'
    }; SUMMARY_SLOT_BACKED=${
      flag('SUMMARY_SLOT_BACKED') ? 'on (slot-backed summary + slot writes)' : 'off (customer-only summarizer)'
    }; AI_CONFIG_VERSIONED_CACHE=${
      versionedCache ? 'on (CAS/versioned + write-through; C-55 healed)' : 'off (EX900 delete-only)'
    }`,
  );

  // P2-5: Albanian/Gheg + prompt hygiene.
  const footerAllTenants = flag('RESTRICTIONS_FOOTER_ALL_TENANTS');
  const promptAllowlistBudget = flag('PROMPT_ALLOWLIST_BUDGET');
  console.info(
    `[albanian] GHEG_LEXICONS=${
      flag('GHEG_LEXICONS') ? 'on (Gheg forms appended; EV-010 routed as other-options)' : 'off (Tosk-only lexicons)'
    }; DIALECT_NORMALIZATION=${
      flag('DIALECT_NORMALIZATION') ? 'on (lexical arm folded + unified stopwords)' : 'off (keyword/phrase arms disagree on diacritics)'
    }; RESTRICTIONS_FOOTER_ALL_TENANTS=${
      footerAllTenants ? 'on (platform rulebook renders for every tenant)' : 'off (footer reaches 1/6 tenants)'
    }; PROMPT_ALLOWLIST_BUDGET=${
      promptAllowlistBudget
        ? `on (orphan blocks rejected; guidelines<=${eff('PROMPT_GUIDELINES_MAX_CHARS')} chars, prompt reported >${eff('PROMPT_ASSEMBLY_MAX_CHARS')})`
        : 'off (orphan offers_promotions renders; prompt unbudgeted)'
    }`,
  );
  if (footerAllTenants && promptAllowlistBudget) {
    console.info(
      '[albanian] NOTE: the platform footer (+~2.2K chars/tenant) and the prompt budget are BOTH on — ' +
        'the interaction the P2-5 plan flags as its top risk. The footer is never truncated by design.',
    );
  }

  // P3-5: prompt versioning & governance.
  const sectionBudget = eff('PROMPT_SECTION_BUDGET');
  const blockRegistry = flag('PROMPT_BLOCK_REGISTRY');
  const selfHealOff = flag('PROMPT_SELF_HEAL_OFF_HOT_PATH');
  console.info(
    `[prompt-governance] PROMPT_BLOCK_REGISTRY=${
      blockRegistry
        ? 'on (per-reply block versions + assembly outcome in the ledger)'
        : 'off (no per-reply ledger provenance; registry still records admin/reconcile writes)'
    }; PROMPT_ASSEMBLY_ALERTS=${
      flag('PROMPT_ASSEMBLY_ALERTS') ? 'on (orphan/violation raises a deduped alert)' : 'off (console.warn only)'
    }; PROMPT_SELF_HEAL_OFF_HOT_PATH=${
      selfHealOff ? 'on (marker-gated; sweep repairs drift)' : 'off (COUNT + force-sync on EVERY reply)'
    }; PROMPT_SECTION_BUDGET=${sectionBudget}${
      sectionBudget === 'enforce' ? ` (ceiling ${eff('PROMPT_ASSEMBLY_MAX_CHARS')} chars ENFORCED)` : ''
    }; UNCERTAIN_GUARD_CATALOG_ALTERNATIVES=${
      flag('UNCERTAIN_GUARD_CATALOG_ALTERNATIVES')
        ? 'on (R6/R13 alternatives checked against the full catalog)'
        : "off (carve-out keys on this turn's retrieval window)"
    }`,
  );
  // (The former PROMPT_SELF_HEAL_OFF_HOT_PATH-without-registry warning is gone: the reconcile
  // sweep's marker/force-sync steps now run for either flag, so the combination is safe.)

  // P2-6: provider-failure isolation. `OPENAI_TIMEOUT_MS` is PER ATTEMPT, so state the real
  // worst-case a reader would otherwise have to compute from two knobs.
  const degrade = flag('GRACEFUL_DEGRADE_MODE');
  const breakerMode = eff('OPENAI_CIRCUIT_BREAKER');
  const callCap = Number(eff('OPENAI_CALL_TIMEOUT_MS'));
  const turnBudget = Number(eff('OPENAI_TURN_DEADLINE_MS'));
  const uncappedWorstCase = Number(eff('OPENAI_TIMEOUT_MS')) * (1 + Number(eff('OPENAI_MAX_RETRIES')));
  console.info(
    `[provider] GRACEFUL_DEGRADE_MODE=${
      degrade ? 'on (provider failure ⇒ holding + provider_unavailable alert; no pause)' : 'off (reply sent even if its guards fail-opened)'
    }; OPENAI_CALL_TIMEOUT_MS=${
      callCap > 0 ? `${callCap} (whole call, incl. retries)` : `0 = off (worst case ${uncappedWorstCase}ms/call)`
    }; OPENAI_TURN_DEADLINE_MS=${
      turnBudget > 0 ? `${turnBudget} (shared across the turn's ~25 calls)` : '0 = off (turn unbounded)'
    }; OPENAI_CIRCUIT_BREAKER=${
      breakerMode === 'on'
        ? `on (opens after ${eff('OPENAI_BREAKER_FAILURE_THRESHOLD')} consecutive failures, cooldown ${eff('OPENAI_BREAKER_COOLDOWN_MS')}ms)`
        : breakerMode === 'monitor'
          ? 'monitor (would-open events recorded; nothing fast-fails)'
          : 'off (inert — no state, no alerts)'
    }`,
  );

  // Both rules below are pure, exported predicates (services/providerResilience.ts) rather than
  // conditions written inline here — same split as this file's own detect/applyMode: the rule is a
  // tested contract, the log string is just its rendering. Warn, never fatal: a mis-set deploy must
  // not become an outage (this file's standing posture).
  const posture: ProviderPosture = {
    degradeEnabled: degrade,
    breakerMode: breakerMode as BreakerMode,
    callCapMs: callCap,
    turnBudgetMs: turnBudget,
    breakerCooldownMs: Number(eff('OPENAI_BREAKER_COOLDOWN_MS')),
  };

  if (enforcementWithoutFloor(posture)) {
    console.warn(
      '[provider] ⚠ P2-6 enforcement is ON but GRACEFUL_DEGRADE_MODE is OFF. A provider blip can now ' +
        'abort the cancellation/refund detector FAST, and the sensitive umbrella will fall through to a ' +
        'normal sales reply (RC-19) — an outcome the uncapped 240s grind mostly avoided. Set ' +
        'GRACEFUL_DEGRADE_MODE=true, or unset OPENAI_CALL_TIMEOUT_MS / OPENAI_TURN_DEADLINE_MS and ' +
        'return OPENAI_CIRCUIT_BREAKER to off/monitor.',
    );
  }

  if (breakerCooldownOutrunsRetries(posture)) {
    console.warn(
      `[provider] ⚠ OPENAI_BREAKER_COOLDOWN_MS=${posture.breakerCooldownMs} is >= aiQueue's ` +
        `${AI_QUEUE_BACKOFF_BASE_MS}ms backoff base. All 3 retries would fast-fail inside the cooldown ` +
        'without re-probing, so every in-flight ai.reply would dead-letter on a short outage. Lower it, ' +
        'or raise the queue backoff in the same change.',
    );
  }

  const lockTtlMs = Number(eff('AI_CONVERSATION_LOCK_TTL_MS'));
  if (turnDeadlineOutrunsLock(turnBudget, lockTtlMs)) {
    console.warn(
      `[provider] ⚠ OPENAI_TURN_DEADLINE_MS=${turnBudget} x2 (pre-send + re-armed tail) is >= ` +
        `AI_CONVERSATION_LOCK_TTL_MS=${lockTtlMs}, which is never renewed. The conversation lock can ` +
        'expire mid-turn and a second job for the same conversation can start. Lower the deadline or ' +
        'raise the lock TTL so 2x deadline stays under it with margin.',
    );
  }

  // P2-audit (XA-F3): cross-item flag couplings the individual item postures above cannot see.
  if (orderStageMode === 'on' && !flag('GHEG_LEXICONS')) {
    console.warn(
      '[classifiers] ⚠ ORDER_STAGE_MACHINE=on with GHEG_LEXICONS=off: the FSM consent lexicon is ' +
        "Tosk-only, so a Gheg consent turn ('e du', 'pe porositi', 'aha okej') is silently missed and " +
        'the order is never created. Enable GHEG_LEXICONS with (or before) the FSM cutover.',
    );
  }
  if (degrade && !flag('HISTORY_DELIVERY_FILTERED')) {
    console.warn(
      '[provider] ⚠ GRACEFUL_DEGRADE_MODE=on with HISTORY_DELIVERY_FILTERED=off: a degraded-turn ' +
        "holding reply re-enters the NEXT turn's transcript as an authoritative assistant statement " +
        '(the legacy binary role map), so the model may repeat "a team member will follow up" instead ' +
        'of answering once the provider recovers. Enable HISTORY_DELIVERY_FILTERED with the floor.',
    );
  }
}
