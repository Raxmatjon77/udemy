import { serializeJsonLd } from '@/lib/catalog/seo';

/**
 * Structured data as `<script type="application/ld+json">`. A JSON data block is never executed,
 * and it also carries this response's CSP nonce, so it passes `script-src 'nonce-…'
 * 'strict-dynamic'` however a browser classifies it. The JSON is escaped so that no value can
 * close the element (`serializeJsonLd`). `dangerouslySetInnerHTML` is the only way to emit raw
 * text in a script element; the input is our own serialized object, never user HTML.
 */
export function JsonLd({ data, nonce }: { data: unknown; nonce?: string | undefined }) {
  return (
    <script
      type="application/ld+json"
      nonce={nonce}
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}
