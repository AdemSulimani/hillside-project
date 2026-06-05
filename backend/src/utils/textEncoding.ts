/**
 * Detects classic UTF-8-as-Latin-1 mojibake (e.g. "Ã«" instead of "ë", "Ã§" instead of "ç").
 * Common when CSV/spreadsheet files encoded in Windows-1252 are read as UTF-8.
 */
const MOJIBAKE_MARKERS = /Ã.|Â./;

export function looksLikeMojibake(text: string): boolean {
  return MOJIBAKE_MARKERS.test(text);
}

/**
 * Re-interprets a Latin-1 misread of UTF-8 bytes back into proper Unicode.
 * Returns the original string when repair does not improve the text.
 */
export function repairMojibake(text: string): string {
  if (!text || !looksLikeMojibake(text)) return text;

  try {
    const repaired = Buffer.from(text, 'latin1').toString('utf8');
    if (!repaired || repaired === text) return text;
    if (!looksLikeMojibake(repaired)) return repaired;
    if (countMojibakeMarkers(repaired) < countMojibakeMarkers(text)) return repaired;
  } catch {
    // Keep the original text if repair fails.
  }

  return text;
}

function countMojibakeMarkers(text: string): number {
  const matches = text.match(/Ã.|Â./g);
  return matches?.length ?? 0;
}

export function repairUtf8Text(text: string | null | undefined): string | null {
  if (text == null) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  return repairMojibake(trimmed);
}

export function repairOptionalUtf8Text(text: string | null | undefined): string | null {
  if (text == null) return null;
  const repaired = repairMojibake(text);
  const trimmed = repaired.trim();
  return trimmed || null;
}

/**
 * Decodes a raw CSV/spreadsheet buffer that may be UTF-8 (with or without BOM)
 * or a legacy Windows single-byte encoding.
 */
export function decodeLegacyTextBuffer(buffer: Buffer): string {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }

  const utf8 = buffer.toString('utf8');
  if (!looksLikeMojibake(utf8) && !utf8.includes('\uFFFD')) return utf8;

  const latin1 = buffer.toString('latin1');
  const repaired = repairMojibake(latin1);
  if (!repaired.includes('\uFFFD')) return repaired;

  return utf8;
}
