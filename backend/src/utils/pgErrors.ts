export function isPgError(err: unknown): err is { code: string; constraint?: string; detail?: string } {
  return Boolean(err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string');
}

export function isPgUniqueViolation(err: unknown): boolean {
  return isPgError(err) && err.code === '23505';
}

export function isPgCheckViolation(err: unknown): boolean {
  return isPgError(err) && err.code === '23514';
}

export function pgConstraintName(err: unknown): string | undefined {
  return isPgError(err) ? err.constraint : undefined;
}
