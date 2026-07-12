/**
 * Preflight safety checks for the migration runner (audit P0-1 / RC-23).
 *
 * Pure functions over filenames only — they never inspect historical
 * `_migrations` rows beyond taking the max applied ordinal, because the
 * deployed database contains rows for since-deleted files applied out of
 * numeric order (offers branch, EV-037) that must stay legal forever.
 */

/**
 * Ordinals that historically shipped with more than one file. The runner keys
 * on filename, both files are applied everywhere, and renumbering them would
 * re-apply content on existing databases — so they are permanently allowlisted.
 * Renumbering/consolidation is out of scope here (audit P3-3).
 */
export const DUPLICATE_ORDINAL_ALLOWLIST: ReadonlyMap<number, ReadonlySet<string>> = new Map([
  [
    62,
    new Set([
      '062_compact_edge_case_guidelines.sql',
      '062_message_product_context.sql',
    ]),
  ],
]);

/** Numeric prefix of a migration filename ("068_add_x.sql" -> 68), or null. */
export function parseOrdinal(filename: string): number | null {
  const match = /^(\d+)_/.exec(filename);
  return match ? parseInt(match[1], 10) : null;
}

/** Max parseable ordinal among applied migration names, or null if none. */
export function maxOrdinal(names: Iterable<string>): number | null {
  let max: number | null = null;
  for (const name of names) {
    const ordinal = parseOrdinal(name);
    if (ordinal !== null && (max === null || ordinal > max)) {
      max = ordinal;
    }
  }
  return max;
}

/**
 * Two files sharing a numeric prefix are both applied (tracking is by
 * filename), in lexicographic — not intended — order. Fail fast unless the
 * colliding group is exactly a known historical duplicate.
 */
export function findDuplicateOrdinals(
  files: string[],
  allowlist: ReadonlyMap<number, ReadonlySet<string>> = DUPLICATE_ORDINAL_ALLOWLIST,
): string[] {
  const byOrdinal = new Map<number, string[]>();
  for (const file of files) {
    const ordinal = parseOrdinal(file);
    if (ordinal === null) continue;
    const group = byOrdinal.get(ordinal);
    if (group) {
      group.push(file);
    } else {
      byOrdinal.set(ordinal, [file]);
    }
  }

  const errors: string[] = [];
  for (const [ordinal, group] of byOrdinal) {
    if (group.length < 2) continue;
    const allowed = allowlist.get(ordinal);
    if (allowed && group.every((file) => allowed.has(file))) continue;
    errors.push(
      `duplicate migration ordinal ${String(ordinal).padStart(3, '0')}: ${group
        .slice()
        .sort()
        .join(', ')} — renumber the new file past the highest existing ordinal`,
    );
  }
  return errors;
}

/**
 * A pending file numbered below the max already-applied ordinal would apply
 * out of numeric order (e.g. a 063_x.sql merged after 068 ran). Fail fast so
 * it gets renumbered instead of silently applying late.
 */
export function findNonMonotonicPending(
  pendingFiles: string[],
  maxAppliedOrdinal: number | null,
): string[] {
  if (maxAppliedOrdinal === null) return [];
  const errors: string[] = [];
  for (const file of pendingFiles) {
    const ordinal = parseOrdinal(file);
    if (ordinal !== null && ordinal < maxAppliedOrdinal) {
      errors.push(
        `pending migration ${file} (ordinal ${ordinal}) is numbered below the highest applied ordinal ${maxAppliedOrdinal} — renumber it past the highest existing ordinal`,
      );
    }
  }
  return errors;
}

/** All preflight violations for the given on-disk files and applied names. */
export function runMigrationChecks(
  filesOnDisk: string[],
  appliedNames: ReadonlySet<string>,
): string[] {
  const pending = filesOnDisk.filter((file) => !appliedNames.has(file));
  return [
    ...findDuplicateOrdinals(filesOnDisk),
    ...findNonMonotonicPending(pending, maxOrdinal(appliedNames)),
  ];
}
