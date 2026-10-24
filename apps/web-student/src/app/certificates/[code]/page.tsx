import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { CertificatePdfButton } from '@/components/learning/certificate-pdf-button';
import { courseHref } from '@/lib/commerce/links';
import { formatDate } from '@/lib/format';
import { getCertificateVerification } from '@/lib/learning/server';

/**
 * `/certificates/{code}` (public, design D7, §10): server-rendered verification of a
 * certificate, valid or revoked. `noindex` (the owner shares the link; search engines must not
 * list people's certificates) and `Referrer-Policy: no-referrer` (next.config.ts).
 */
export async function generateMetadata({
  params,
}: PageProps<'/certificates/[code]'>): Promise<Metadata> {
  const { code } = await params;
  const certificate = await getCertificateVerification(code);
  if (!certificate) return { title: 'Certificate not found', robots: { index: false } };
  const title = `Certificate of completion: ${certificate.courseTitle}`;
  const description = `${certificate.recipientName} completed “${certificate.courseTitle}” by ${certificate.instructorName}.`;
  return {
    title,
    description,
    robots: { index: false, follow: false },
    openGraph: { type: 'website', siteName: 'Udemy', title, description },
  };
}

export default async function CertificatePage({ params }: PageProps<'/certificates/[code]'>) {
  const { code } = await params;
  const certificate = await getCertificateVerification(code);
  if (!certificate) notFound();
  const revoked = certificate.status === 'REVOKED';

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10 sm:px-6">
      <section
        aria-labelledby="certificate-title"
        data-testid="certificate"
        data-status={certificate.status}
        className="flex flex-col items-center gap-4 rounded-xl border-4 border-double p-8 text-center"
      >
        <p className="text-sm tracking-widest text-muted-foreground uppercase">
          Certificate of completion
        </p>
        <h1 id="certificate-title" className="text-3xl font-bold text-balance">
          {certificate.courseTitle}
        </h1>
        <p>
          Awarded to <span className="font-semibold">{certificate.recipientName}</span>
        </p>
        <p className="text-sm text-muted-foreground">
          Instructor: {certificate.instructorName} · Issued{' '}
          <time dateTime={certificate.issuedAt}>{formatDate(certificate.issuedAt)}</time>
        </p>
        <p
          role="status"
          className={
            revoked
              ? 'rounded-md bg-destructive/10 px-3 py-1 text-sm font-medium text-destructive'
              : 'rounded-md bg-emerald-600/10 px-3 py-1 text-sm font-medium text-emerald-700 dark:text-emerald-400'
          }
        >
          {revoked
            ? `This certificate was revoked${
                certificate.revokedAt ? ` on ${formatDate(certificate.revokedAt)}` : ''
              } and is no longer valid.`
            : 'This certificate is valid.'}
        </p>
        <p className="font-mono text-xs text-muted-foreground">
          Certificate ID: {certificate.code}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          {certificate.pdfAvailable ? <CertificatePdfButton code={certificate.code} /> : null}
          {certificate.courseSlug ? (
            <Link
              href={courseHref(certificate.courseSlug)}
              className="inline-flex h-9 items-center rounded-md px-4 text-sm font-medium hover:bg-accent"
            >
              View the course
            </Link>
          ) : null}
        </div>
      </section>
    </main>
  );
}
