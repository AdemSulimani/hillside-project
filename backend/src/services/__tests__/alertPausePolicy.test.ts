/**
 * Pins `alertPausePolicy.ts` — the descriptive statement of which alert reasons come with a
 * paused conversation — against the PRODUCTION source that actually wires pauses and alerts.
 *
 * The policy module is deliberately not read by the pipeline (see its header), so nothing at
 * runtime would ever notice it drifting from reality. This suite is the enforcement point:
 *  - every reason stamped into a `setConversationAiPaused(..., true, ...)` call must map to
 *    `'pauses'`;
 *  - every reason a `createAIAlert` call can carry must be a key of the policy at all;
 *  - a reason the policy calls `notify_only` must never appear as a pause stamp.
 *
 * `processAIReply.ts` is not importable in unit scope (its module graph reaches openaiClient's
 * boot-fatal env reads), so — per the house convention of `replyPathSourceInvariants.test.ts` /
 * `evalIsolation.test.ts` — the pipeline half is asserted over source text, with count guards
 * so a refactor cannot make the assertions pass vacuously. The dynamic reason identifiers
 * (`groundingGateReason`, `flagReason`, `UNCERTAIN_ANSWER_ALERT_REASON`) are resolved to their
 * possible values via their owning modules' exports or pinned union source.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { ALERT_PAUSE_POLICY, alertReasonPauses } from '../alertPausePolicy';
import { SENSITIVE_ALERT_REASONS } from '../aiResumePolicy';
import { FLAG_REASON_VALUES } from '../aiQualityContract';
import { UNCERTAIN_ANSWER_ALERT_REASON } from '../uncertainAnswerFallbackGuard';
import { MULTIPLE_CHANNELS_MATCHED_REASON } from '../channelIsolation';
import { PROMPT_ASSEMBLY_ALERT_REASON } from '../promptAssemblyAlerts';

function findSrcDir(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'src');
    if (existsSync(path.join(candidate, 'services', 'aiService.ts'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate backend/src from cwd ${process.cwd()}`);
}

const SRC = findSrcDir();
const pipelineSource = readFileSync(path.join(SRC, 'jobs', 'processAIReply.ts'), 'utf8');
const failureHandlerSource = readFileSync(path.join(SRC, 'jobs', 'failureHandler.ts'), 'utf8');
const refreshTokensSource = readFileSync(path.join(SRC, 'jobs', 'refreshMetaTokens.ts'), 'utf8');
const groundingGateSource = readFileSync(path.join(SRC, 'services', 'groundingGate.ts'), 'utf8');

const PAUSES = new Set(
  Object.entries(ALERT_PAUSE_POLICY)
    .filter(([, behavior]) => behavior === 'pauses')
    .map(([reason]) => reason),
);
const NOTIFY_ONLY = new Set(
  Object.entries(ALERT_PAUSE_POLICY)
    .filter(([, behavior]) => behavior === 'notify_only')
    .map(([reason]) => reason),
);

/** All indices at which `needle` occurs in `haystack`. */
function indicesOf(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = haystack.indexOf(needle, i + 1);
  }
  return out;
}

/**
 * The dynamic identifiers a pause/alert site may pass as its reason, resolved to every value
 * they can take at runtime. `groundingGateReason` is typed `GroundingReason` (union pinned
 * below against the source); `flagReason` comes from `FLAG_REASON_VALUES`.
 */
const DYNAMIC_REASON_VALUES: Record<string, readonly string[]> = {
  groundingGateReason: [
    'hallucinated_price',
    'hallucinated_product_name',
    'hallucinated_product_attribute',
    'grounding_check_unavailable',
  ],
  flagReason: FLAG_REASON_VALUES,
  UNCERTAIN_ANSWER_ALERT_REASON: [UNCERTAIN_ANSWER_ALERT_REASON],
};

describe('the GroundingReason union is what this suite thinks it is', () => {
  it('groundingGate.ts declares exactly the four pinned members', () => {
    const unionStart = groundingGateSource.indexOf('export type GroundingReason =');
    assert.notEqual(unionStart, -1, 'GroundingReason union not found in groundingGate.ts');
    const unionBlock = groundingGateSource.slice(unionStart, unionStart + 300);
    for (const member of DYNAMIC_REASON_VALUES.groundingGateReason) {
      assert.ok(unionBlock.includes(`'${member}'`), `GroundingReason lost member '${member}'`);
    }
    const memberCount = (unionBlock.slice(0, unionBlock.indexOf(';')).match(/'/g) ?? []).length / 2;
    assert.equal(memberCount, 4, `GroundingReason has ${memberCount} members, expected 4`);
  });
});

describe('every pause stamp in the pipeline maps to `pauses`', () => {
  // Anchor on the exact production call shape. The 5th argument is the stamped reason: a
  // string literal, a ternary of two literals (cancellation/refund), or a dynamic identifier.
  const pauseCallRe =
    /setConversationAiPaused\(\s*conversationId,\s*tenantId,\s*true,\s*(?:client|pool),\s*([^)]+)\)/g;
  const stamps = [...pipelineSource.matchAll(pauseCallRe)];

  it('the site count guard holds (21 pause stamps)', () => {
    assert.equal(
      stamps.length,
      21,
      `expected 21 setConversationAiPaused(..., true, ...) sites, found ${stamps.length} — ` +
        'a pause was added/removed; update ALERT_PAUSE_POLICY and this guard together',
    );
  });

  it('every stamped reason is known and maps to `pauses`', () => {
    for (const m of stamps) {
      const arg = m[1].trim();
      const literals = [...arg.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
      const reasons =
        literals.length > 0 ? literals : (DYNAMIC_REASON_VALUES[arg] ?? null);
      assert.ok(reasons, `pause stamp uses unrecognized reason expression: ${arg}`);
      for (const reason of reasons) {
        assert.equal(
          alertReasonPauses(reason),
          true,
          `'${reason}' is stamped as a pause reason in processAIReply.ts but ALERT_PAUSE_POLICY ` +
            `says '${(ALERT_PAUSE_POLICY as Record<string, string>)[reason] ?? 'unknown'}'`,
        );
      }
    }
  });
});

describe('every alert reason is covered by the policy', () => {
  /** Collect the `reason:` value of each createAIAlert call in a source file. */
  function collectAlertReasons(source: string, file: string): string[] {
    const sites = indicesOf(source, 'createAIAlert(').filter(
      // skip the import line
      (i) => !source.slice(Math.max(0, i - 60), i).includes('import'),
    );
    const found: string[] = [];
    for (const site of sites) {
      const window = source.slice(site, site + 700);
      const m = window.match(/reason:\s*(?:'([a-z_]+)'|([A-Za-z_][A-Za-z0-9_]*))/);
      assert.ok(m, `createAIAlert site in ${file} has no reason: within its window`);
      if (m[1]) {
        found.push(m[1]);
      } else {
        const resolved = DYNAMIC_REASON_VALUES[m[2]];
        assert.ok(resolved, `createAIAlert site in ${file} uses unrecognized reason ident ${m[2]}`);
        found.push(...resolved);
      }
    }
    return found;
  }

  const pipelineReasons = collectAlertReasons(pipelineSource, 'processAIReply.ts');

  it('the pipeline createAIAlert site count guard holds (28 sites)', () => {
    const sites = indicesOf(pipelineSource, 'createAIAlert(').filter(
      (i) => !pipelineSource.slice(Math.max(0, i - 60), i).includes('import'),
    );
    assert.equal(
      sites.length,
      28,
      `expected 28 createAIAlert sites in processAIReply.ts, found ${sites.length} — ` +
        'an alert was added/removed; update ALERT_PAUSE_POLICY and this guard together',
    );
  });

  it('every alert reason across all producers is a key of ALERT_PAUSE_POLICY', () => {
    const allReasons = new Set([
      ...pipelineReasons,
      ...collectAlertReasons(failureHandlerSource, 'failureHandler.ts'),
      ...collectAlertReasons(refreshTokensSource, 'refreshMetaTokens.ts'),
      MULTIPLE_CHANNELS_MATCHED_REASON,
      PROMPT_ASSEMBLY_ALERT_REASON,
    ]);
    for (const reason of allReasons) {
      assert.notEqual(
        alertReasonPauses(reason),
        null,
        `alert reason '${reason}' is produced but missing from ALERT_PAUSE_POLICY`,
      );
    }
  });

  it('no notify_only reason is ever stamped as a pause', () => {
    for (const reason of NOTIFY_ONLY) {
      assert.ok(
        !pipelineSource.includes(`true, client, '${reason}'`) &&
          !pipelineSource.includes(`true, pool, '${reason}'`),
        `'${reason}' is notify_only in the policy but appears as a pause stamp`,
      );
    }
  });
});

describe('policy internal consistency', () => {
  it('sensitive alert reasons are all pausing (a human must own them)', () => {
    for (const reason of SENSITIVE_ALERT_REASONS) {
      assert.equal(alertReasonPauses(reason), true, `sensitive reason '${reason}' must pause`);
    }
  });

  it('quality flag reasons are all pausing', () => {
    for (const reason of FLAG_REASON_VALUES) {
      assert.equal(alertReasonPauses(reason), true, `flag reason '${reason}' must pause`);
    }
  });

  it('pauses and notify_only partition the policy (no overlap, nothing unmapped)', () => {
    assert.equal(PAUSES.size + NOTIFY_ONLY.size, Object.keys(ALERT_PAUSE_POLICY).length);
    for (const reason of PAUSES) assert.ok(!NOTIFY_ONLY.has(reason));
  });

  it('an unknown reason resolves to null, never a guess', () => {
    assert.equal(alertReasonPauses('some_future_reason'), null);
    assert.equal(alertReasonPauses(null), null);
    assert.equal(alertReasonPauses(undefined), null);
  });
});
