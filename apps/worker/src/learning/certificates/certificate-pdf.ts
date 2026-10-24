import { readFileSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import { create as createQr } from 'qrcode';

/**
 * Certificate PDF (design D7): A4 landscape, rendered with pdfkit and a bundled font, with a QR
 * code that points at the public verification page.
 *
 * Font: DejaVu Sans (npm `dejavu-fonts-ttf`, Bitstream Vera license + public-domain changes;
 * Latin, Cyrillic, Greek, ...), resolved through node module resolution, so it ships with the
 * worker's production dependencies (`pnpm deploy --prod`) and needs no extra Dockerfile COPY.
 * Embedded as a subset; names render as text (no HTML path, design §9).
 *
 * Deterministic: the same input gives the same bytes (CreationDate = issuedAt, no random ids),
 * so a re-render after a crash overwrites the deterministic object key with identical content.
 */

export interface CertificatePdfInput {
  readonly code: string;
  readonly recipientName: string;
  readonly courseTitle: string;
  readonly instructorName: string;
  readonly issuedAt: Date;
  /** `{STUDENT_APP_ORIGIN}/certificates/{code}` (the QR target). */
  readonly verifyUrl: string;
}

const FONT_FILES = {
  regular: 'dejavu-fonts-ttf/ttf/DejaVuSans.ttf',
  bold: 'dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf',
} as const;

let fonts: { regular: Buffer; bold: Buffer } | undefined;

/** Loads the bundled TTFs once (throws at the first render if the package is missing). */
export function certificateFonts(): { regular: Buffer; bold: Buffer } {
  fonts ??= {
    regular: readFileSync(require.resolve(FONT_FILES.regular)),
    bold: readFileSync(require.resolve(FONT_FILES.bold)),
  };
  return fonts;
}

/** `2026-10-24`. */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const INK = '#1c1d1f';
const MUTED = '#6a6f73';
const ACCENT = '#5624d0';

/** Draws the QR modules as filled squares (vector, no image) with its top-left at (x, y). */
function drawQr(doc: PDFKit.PDFDocument, text: string, x: number, y: number, size: number): void {
  const qr = createQr(text, { errorCorrectionLevel: 'M' });
  const count = qr.modules.size;
  const cell = size / count;
  doc.save();
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.modules.get(row, col)) doc.rect(x + col * cell, y + row * cell, cell, cell);
    }
  }
  doc.fill(INK);
  doc.restore();
}

/** Renders the certificate; resolves with the complete PDF bytes. */
export function renderCertificatePdf(input: CertificatePdfInput): Promise<Buffer> {
  const { regular, bold } = certificateFonts();
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margin: 0,
    info: {
      Title: `Certificate of completion: ${input.courseTitle}`,
      Author: 'Udemy Clone',
      Subject: input.code,
      CreationDate: input.issuedAt,
      ModDate: input.issuedAt,
    },
  });
  const done = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.registerFont('Regular', regular);
  doc.registerFont('Bold', bold);
  const width = doc.page.width;
  const height = doc.page.height;
  const inner = width - 160;

  doc
    .lineWidth(3)
    .strokeColor(ACCENT)
    .rect(24, 24, width - 48, height - 48)
    .stroke();
  doc
    .lineWidth(1)
    .strokeColor(MUTED)
    .rect(34, 34, width - 68, height - 68)
    .stroke();

  doc.font('Bold').fontSize(34).fillColor(ACCENT);
  doc.text('Certificate of Completion', 80, 90, { width: inner, align: 'center' });
  doc.font('Regular').fontSize(14).fillColor(MUTED);
  doc.text('This certifies that', 80, 160, { width: inner, align: 'center' });
  doc.font('Bold').fontSize(30).fillColor(INK);
  doc.text(input.recipientName, 80, 190, { width: inner, align: 'center' });
  doc.font('Regular').fontSize(14).fillColor(MUTED);
  doc.text('has successfully completed the course', 80, 245, { width: inner, align: 'center' });
  doc.font('Bold').fontSize(22).fillColor(INK);
  doc.text(input.courseTitle, 80, 275, { width: inner, align: 'center' });
  doc.font('Regular').fontSize(13).fillColor(INK);
  doc.text(`Instructor: ${input.instructorName}`, 80, 335, { width: inner, align: 'center' });

  const qrSize = 110;
  const qrX = width - 80 - qrSize;
  const qrY = height - 80 - qrSize;
  drawQr(doc, input.verifyUrl, qrX, qrY, qrSize);

  doc.font('Regular').fontSize(11).fillColor(MUTED);
  doc.text(`Issued on ${isoDate(input.issuedAt)}`, 80, height - 160, { width: qrX - 100 });
  doc.text(`Certificate code: ${input.code}`, 80, height - 140, { width: qrX - 100 });
  doc.text(`Verify at: ${input.verifyUrl}`, 80, height - 120, { width: qrX - 100 });

  doc.end();
  return done;
}
