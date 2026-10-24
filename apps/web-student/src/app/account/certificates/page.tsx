import type { Metadata } from 'next';

import { MyCertificates } from '@/components/learning/my-certificates';

export const metadata: Metadata = { title: 'Certificates', robots: { index: false } };

/** `/account/certificates` (session required): my certificates of completion. */
export default function CertificatesPage() {
  return (
    <section aria-labelledby="certificates-title" className="flex flex-col gap-4">
      <h1 id="certificates-title" className="text-2xl font-semibold">
        Certificates
      </h1>
      <MyCertificates />
    </section>
  );
}
