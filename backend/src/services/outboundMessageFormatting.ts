/**
 * Presentation-only cleanup applied to the final AI reply text right before it is
 * sent to the customer channel (Instagram / WhatsApp / Messenger).
 *
 * This layer changes NOTHING about what the AI decides to say — it only tidies how
 * the text is rendered:
 *   - Removes Markdown emphasis markers (bold/italic). Product names and other text
 *     should appear as plain text; Instagram shows the raw `**...**` / `*...*`
 *     markers literally, and on WhatsApp single asterisks render as bold. Stripping
 *     the markers (while keeping the inner words) gives clean, normal text on every
 *     channel.
 *   - Strips leading list markers (dash `-`, bullet `•`, middle-dot `·`) from the
 *     start of lines. The AI is instructed to avoid bullet lists, but when it
 *     accidentally uses them the markers show as visible punctuation on messaging
 *     apps (e.g. the "janë: -" wrapping artefact seen on mobile). Removing them
 *     keeps product-name lists clean without altering any content or wording.
 *   - Collapses runs of blank lines so sections never have excessive vertical gaps
 *     (a single blank line between paragraphs is preserved), and trims trailing
 *     whitespace on every line.
 *
 * Intentionally dependency-free and pure so it is fully unit-testable in-process.
 */

/** Remove Markdown bold/italic markers while preserving the wrapped text. */
function stripEmphasisMarkers(text: string): string {
  let out = text;
  // Bold: **text** and __text__ (require non-space, non-marker inner content).
  out = out.replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, '$1');
  out = out.replace(/__(?=\S)([^_\n]+?)(?<=\S)__/g, '$1');
  // Italic / single-asterisk bold (WhatsApp): *text*. Guarded so it never touches a
  // lone asterisk used as an operator/bullet (e.g. "2 * 3" or a leading "* item"):
  // the opening marker must hug the first character and the closing marker the last.
  out = out.replace(/(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/g, '$1');
  return out;
}

/**
 * Strip leading list markers (-, •, ·) from the beginning of any line.
 * A whitespace character after the marker is required, so mid-word hyphens
 * (e.g. "N-Acetyl Cysteine" at the start of a line) are never touched.
 */
function stripLeadingListMarkers(text: string): string {
  return text.replace(/^[-•·][ \t]+/gm, '');
}

/** Collapse excessive blank lines and trim trailing per-line whitespace. */
function normalizeVerticalSpacing(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    // Two or more consecutive newlines (i.e. one or more blank lines) collapse to a
    // single blank line, so paragraph breaks survive but big gaps disappear.
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Final presentation cleanup for an outbound AI message. Safe to apply to any
 * channel: it only removes formatting noise, never wording.
 */
export function sanitizeOutboundMessageText(text: string): string {
  if (!text) return text;
  return normalizeVerticalSpacing(stripLeadingListMarkers(stripEmphasisMarkers(text)));
}
