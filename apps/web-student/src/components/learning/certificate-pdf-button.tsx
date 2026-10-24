'use client';

import { useMutation } from '@tanstack/react-query';
import { ErrorCode } from '@udemy/contracts';
import { Button } from '@udemy/ui/components/button';
import { Spinner } from '@udemy/ui/components/spinner';

import { assignLocation } from '@/lib/commerce/navigation';
import { fetchMyCertificatePdf, fetchPublicCertificatePdf } from '@/lib/learning/client';
import { problemMessage } from '@/lib/problem';

const PDF_MESSAGES = {
  [ErrorCode.CertificatePdfPending]: 'The PDF is still being generated. Try again in a minute.',
  [ErrorCode.CertificateNotFound]: 'This certificate is not available.',
};

/**
 * Downloads a certificate PDF: a presigned, short-lived URL fetched on click (never rendered
 * into the page), by public code or as the owner (`certificateId`).
 */
export function CertificatePdfButton({
  code,
  certificateId,
  variant = 'default',
}: {
  code?: string;
  certificateId?: string;
  variant?: 'default' | 'outline';
}) {
  const pdf = useMutation({
    mutationFn: () =>
      certificateId ? fetchMyCertificatePdf(certificateId) : fetchPublicCertificatePdf(code!),
    onSuccess: (signed) => assignLocation(signed.url),
  });
  return (
    <span className="inline-flex flex-col items-center gap-1">
      <Button variant={variant} size="sm" onClick={() => pdf.mutate()} disabled={pdf.isPending}>
        {pdf.isPending ? <Spinner className="size-4" /> : null}
        Download PDF
      </Button>
      {pdf.isError ? (
        <span role="alert" className="text-xs text-destructive">
          {problemMessage(pdf.error, PDF_MESSAGES)}
        </span>
      ) : null}
    </span>
  );
}
