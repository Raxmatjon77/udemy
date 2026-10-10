/** Control characters (incl. CR/LF, which would inject headers) and path separators. */
// eslint-disable-next-line no-control-regex
const UNSAFE_FILENAME_CHARS = /[\u0000-\u001f\u007f-\u009f/\\]/g;

/**
 * `Content-Disposition: attachment` with an RFC 6266 / RFC 5987 filename (design §9: the original
 * filename is display-only and emitted with RFC 5987 encoding). Safe to pass as
 * `responseContentDisposition` to `ObjectStorage.presignGet`.
 *
 *   attachmentContentDisposition('Résumé "final".pdf')
 *   // attachment; filename="R_sum_ _final_.pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%22final%22.pdf
 */
export function attachmentContentDisposition(filename?: string): string {
  if (filename === undefined) return 'attachment';
  const cleaned = filename.replace(UNSAFE_FILENAME_CHARS, '_').trim().slice(0, 255);
  if (cleaned === '') return 'attachment';
  const fallback = cleaned.replace(/[^\x20-\x7e]|["%;]/g, '_');
  const encoded = encodeURIComponent(cleaned).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
