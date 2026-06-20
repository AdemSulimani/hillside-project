/**
 * Pure, dependency-light resolution policy that merges STRUCTURED catalog attributes
 * with IMAGE-DERIVED packaging facts (read by the vision model from product images)
 * into a single, confidence-gated view that the reply model and the escalation
 * classifier can both trust.
 *
 * Design goals (mirrors productImageMatchPolicy.ts):
 *   - NO I/O and NO heavy runtime imports so the precedence/conflict rules can be
 *     unit-tested exhaustively and the thresholds live in one documented place.
 *   - GENERIC over attributes: it does not hard-code "brand/flavor/servings". It works
 *     over any named field and any key in the open `attributes` map, so the system can
 *     answer arbitrary product-detail questions, not a fixed list.
 *
 * Precedence for every attribute:
 *   structured catalog value (if non-empty)  →  high-confidence image-derived value  →  unavailable
 */
import type { VisualFingerprintData } from '../db/models/productImageFingerprint';
import { normalizeAttributeKey } from '../db/models/productImageFingerprint';

/** Minimum confidence to answer a NON-numeric image-derived fact (e.g. brand, flavor, directions). */
export const ATTR_ANSWER_CONFIDENCE_MIN = clamp01(
  parseFloat(process.env.ATTR_ANSWER_CONFIDENCE_MIN || '0.75'),
  0.75,
);
/** Higher bar for NUMERIC facts (servings, weight, calories, protein) where a wrong number is costly. */
export const ATTR_NUMERIC_CONFIDENCE_MIN = clamp01(
  parseFloat(process.env.ATTR_NUMERIC_CONFIDENCE_MIN || '0.85'),
  0.85,
);
/**
 * If two product images yield DIFFERENT values for the same attribute and both are
 * within this confidence band of each other, the attribute is marked `conflicted`
 * and is never used to answer (prevents asserting one of several contradictory labels).
 */
export const ATTR_CONFLICT_DELTA = clamp01(parseFloat(process.env.ATTR_CONFLICT_DELTA || '0.15'), 0.15);

/**
 * Confidence assigned to an image-derived field when the model did NOT provide a
 * per-attribute confidence (e.g. legacy v1 fingerprints). Intentionally below the
 * answer thresholds so old fingerprints never answer until re-extracted with the
 * richer v2 schema.
 */
export const DEFAULT_FIELD_CONFIDENCE = clamp01(
  parseFloat(process.env.ATTR_DEFAULT_FIELD_CONFIDENCE || '0.5'),
  0.5,
);

export type AttributeSource = 'catalog' | 'image';

export interface ResolvedAttribute {
  /** Normalized attribute key (lowercase, e.g. "brand", "servings", "protein per serving"). */
  key: string;
  /** Human-friendly label for prompts. */
  label: string;
  value: string;
  source: AttributeSource;
  /** 1.0 for structured catalog values; model confidence for image-derived ones. */
  confidence: number;
  /** True when multiple product images disagreed at comparable confidence. */
  conflicted: boolean;
  /** True when this value is trustworthy enough to answer a customer directly. */
  usable: boolean;
}

/** Subset of a Product needed for resolution — keeps this module free of the full model type. */
export interface StructuredAttributeInput {
  brand?: string | null;
  category?: string | null;
  flavor?: string | null;
  size?: string | null;
  color?: string | null;
  variant?: string | null;
  weight?: string | null;
}

export interface FingerprintInput {
  fingerprint_json: Partial<VisualFingerprintData> | null | undefined;
  fingerprint_version?: number | null;
}

export interface ResolveOptions {
  answerConfidenceMin?: number;
  numericConfidenceMin?: number;
  conflictDelta?: number;
  defaultFieldConfidence?: number;
}

function clamp01(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/** A value is treated as numeric (stricter threshold) when it contains any digit. */
export function looksNumeric(value: string): boolean {
  return /\d/.test(value);
}

const FIELD_LABELS: Record<string, string> = {
  brand: 'Brand',
  manufacturer: 'Manufacturer',
  product_name: 'Product name',
  product_type: 'Product type',
  category: 'Category',
  flavor: 'Flavor',
  size: 'Size',
  servings: 'Servings',
  color: 'Color',
  variant: 'Variant',
  weight: 'Weight',
  sku: 'SKU',
};

function labelFor(key: string): string {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  // Title-case a generic key like "protein per serving" → "Protein per serving".
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** Maps the named VisualFingerprintData fields to normalized resolution keys. */
const NAMED_FIELD_KEYS: Array<{ field: keyof VisualFingerprintData; key: string }> = [
  { field: 'brand_name', key: 'brand' },
  { field: 'manufacturer', key: 'manufacturer' },
  { field: 'product_name', key: 'product_name' },
  { field: 'product_type', key: 'product_type' },
  { field: 'category', key: 'category' },
  { field: 'flavor', key: 'flavor' },
  { field: 'size', key: 'size' },
  { field: 'servings', key: 'servings' },
  { field: 'sku_visible', key: 'sku' },
];

interface Candidate {
  key: string;
  value: string;
  confidence: number;
}

/**
 * Pull every image-derived (key, value, confidence) candidate from a single fingerprint.
 * Reads both the named fields and the open `attributes` map.
 */
function candidatesFromFingerprint(fp: Partial<VisualFingerprintData>, defaultConf: number): Candidate[] {
  const out: Candidate[] = [];
  const confMap = fp.attribute_confidence ?? {};

  const confidenceFor = (lookupKeys: string[]): number => {
    for (const k of lookupKeys) {
      const norm = normalizeAttributeKey(k);
      if (typeof confMap[norm] === 'number') return clamp01(confMap[norm], defaultConf);
      if (typeof (confMap as Record<string, number>)[k] === 'number') {
        return clamp01((confMap as Record<string, number>)[k], defaultConf);
      }
    }
    return defaultConf;
  };

  for (const { field, key } of NAMED_FIELD_KEYS) {
    const raw = fp[field];
    if (typeof raw === 'string' && raw.trim()) {
      out.push({
        key,
        value: raw.trim(),
        confidence: confidenceFor([String(field), key]),
      });
    }
  }

  const attrs = fp.attributes ?? {};
  for (const [rawKey, rawValue] of Object.entries(attrs)) {
    if (typeof rawValue !== 'string' || !rawValue.trim()) continue;
    const key = normalizeAttributeKey(rawKey);
    if (!key) continue;
    out.push({ key, value: rawValue.trim(), confidence: confidenceFor([rawKey, key]) });
  }

  return out;
}

interface AggregatedValue {
  value: string;
  confidence: number;
  conflicted: boolean;
}

/**
 * Aggregate image-derived candidates for a single key across multiple fingerprints,
 * applying conflict detection: if a different normalized value exists within
 * `conflictDelta` of the top candidate's confidence, mark the attribute conflicted.
 */
function aggregateKey(candidates: Candidate[], conflictDelta: number): AggregatedValue {
  const sorted = [...candidates].sort((a, b) => b.confidence - a.confidence);
  const top = sorted[0];
  const topNorm = top.value.trim().toLowerCase();

  let conflicted = false;
  for (let i = 1; i < sorted.length; i++) {
    const other = sorted[i];
    if (other.value.trim().toLowerCase() === topNorm) continue;
    if (top.confidence - other.confidence <= conflictDelta) {
      conflicted = true;
      break;
    }
  }

  return { value: top.value, confidence: top.confidence, conflicted };
}

/**
 * Resolve the full attribute view for ONE product by merging its structured catalog
 * columns with image-derived facts from its fingerprints. Structured (non-empty)
 * values always win and are reported with source 'catalog' at confidence 1.0.
 * Image-derived values fill keys the catalog lacks, gated by confidence/conflict.
 */
export function resolveProductAttributes(
  structured: StructuredAttributeInput,
  fingerprints: FingerprintInput[],
  options?: ResolveOptions,
): Map<string, ResolvedAttribute> {
  const answerMin = options?.answerConfidenceMin ?? ATTR_ANSWER_CONFIDENCE_MIN;
  const numericMin = options?.numericConfidenceMin ?? ATTR_NUMERIC_CONFIDENCE_MIN;
  const conflictDelta = options?.conflictDelta ?? ATTR_CONFLICT_DELTA;
  const defaultConf = options?.defaultFieldConfidence ?? DEFAULT_FIELD_CONFIDENCE;

  const resolved = new Map<string, ResolvedAttribute>();

  // 1) Structured catalog attributes — highest precedence.
  const structuredEntries: Array<[string, string | null | undefined]> = [
    ['brand', structured.brand],
    ['category', structured.category],
    ['flavor', structured.flavor],
    ['size', structured.size],
    ['color', structured.color],
    ['variant', structured.variant],
    ['weight', structured.weight],
  ];
  for (const [key, raw] of structuredEntries) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) continue;
    resolved.set(key, {
      key,
      label: labelFor(key),
      value,
      source: 'catalog',
      confidence: 1,
      conflicted: false,
      usable: true,
    });
  }

  // 2) Collect image-derived candidates grouped by key.
  const byKey = new Map<string, Candidate[]>();
  for (const fp of fingerprints) {
    if (!fp.fingerprint_json) continue;
    for (const cand of candidatesFromFingerprint(fp.fingerprint_json, defaultConf)) {
      const list = byKey.get(cand.key) ?? [];
      list.push(cand);
      byKey.set(cand.key, list);
    }
  }

  // 3) Merge image-derived values for any key not already satisfied by the catalog.
  for (const [key, candidates] of byKey) {
    if (resolved.has(key)) continue; // catalog wins
    const agg = aggregateKey(candidates, conflictDelta);
    const threshold = looksNumeric(agg.value) ? numericMin : answerMin;
    const usable = !agg.conflicted && agg.confidence >= threshold;
    resolved.set(key, {
      key,
      label: labelFor(key),
      value: agg.value,
      source: 'image',
      confidence: agg.confidence,
      conflicted: agg.conflicted,
      usable,
    });
  }

  return resolved;
}

/** Returns only the usable, image-derived attributes (those that fill a catalog gap). */
export function usableImageDerivedAttributes(
  resolved: Map<string, ResolvedAttribute>,
): ResolvedAttribute[] {
  return [...resolved.values()].filter((a) => a.source === 'image' && a.usable);
}

/** Collects unique, readable label text across fingerprints (capped) for a raw fallback line. */
export function collectVisibleText(fingerprints: FingerprintInput[], max = 25): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const fp of fingerprints) {
    const list = fp.fingerprint_json?.visible_text;
    if (!Array.isArray(list)) continue;
    for (const t of list) {
      if (typeof t !== 'string') continue;
      const trimmed = t.trim();
      if (!trimmed) continue;
      const norm = trimmed.toLowerCase();
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push(trimmed);
      if (out.length >= max) return out;
    }
  }
  return out;
}

export interface ImageDerivedBlock {
  /** Prompt-ready text block, or null when there is nothing trustworthy to surface. */
  text: string | null;
  /** The usable image-derived attributes (for telemetry / escalation context). */
  usable: ResolvedAttribute[];
  /** Whether any conflicting attribute was detected (surfaced as a caution line). */
  hadConflict: boolean;
}

/**
 * Build a prompt-ready, provenance-labeled block of packaging-derived facts for ONE
 * product. Only includes image-derived attributes that fill a gap left by the
 * structured catalog (catalog values are already shown elsewhere) and meet the
 * confidence bar. Adds the raw readable label text as a generic fallback so the model
 * can still answer truly arbitrary questions grounded in verified OCR'd text.
 */
export function buildImageDerivedBlockForProduct(
  productName: string,
  structured: StructuredAttributeInput,
  fingerprints: FingerprintInput[],
  options?: ResolveOptions & { includeVisibleText?: boolean },
): ImageDerivedBlock {
  const resolved = resolveProductAttributes(structured, fingerprints, options);
  const usable = usableImageDerivedAttributes(resolved);
  const hadConflict = [...resolved.values()].some((a) => a.source === 'image' && a.conflicted);
  const visibleText = options?.includeVisibleText === false ? [] : collectVisibleText(fingerprints);

  if (usable.length === 0 && visibleText.length === 0) {
    return { text: null, usable: [], hadConflict };
  }

  const lines: string[] = [];
  lines.push(`Product "${productName}" — details read from its packaging image(s):`);
  for (const attr of usable) {
    lines.push(`  - ${attr.label}: ${attr.value} (read from image, confidence ${attr.confidence.toFixed(2)})`);
  }
  if (visibleText.length > 0) {
    lines.push(`  - Other readable label text: ${visibleText.join(' | ')}`);
  }

  return { text: lines.join('\n'), usable, hadConflict };
}
