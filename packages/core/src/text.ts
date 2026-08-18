/**
 * Repair model-generated copy.
 *
 * Two problems show up in practice. First, emoji sometimes arrive as the
 * literal text "😈" rather than the character, which then renders
 * as the escape sequence. Second, decoding those can leave an unpaired
 * surrogate when the model emitted only half of a pair (common with flag
 * emoji): that half is not a valid character on its own and shows as a
 * broken glyph, so it is dropped.
 */
export function decodeEscapes(value: string): string {
  return (
    value
      .replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) =>
        String.fromCharCode(parseInt(hex, 16)),
      )
      // high surrogate with no low surrogate after it
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
      // low surrogate with no high surrogate before it
      .replace(/(^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/g, "$1")
  );
}
