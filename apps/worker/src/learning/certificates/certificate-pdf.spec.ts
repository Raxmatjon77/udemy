import { CERTIFICATE_PUBLIC_CODE_PATTERN } from '@udemy/db';
import { create as createQr } from 'qrcode';
import { describe, expect, it } from 'vitest';
import { CERTIFICATE_CODE_LENGTH, newCertificateCode } from './certificate-code';
import { certificateFonts, renderCertificatePdf } from './certificate-pdf';

const INPUT = {
  code: 'ABCDEFGHJKMNPQRSTVWXYZ0123',
  recipientName: 'Oʻlmas Хамидов',
  courseTitle: 'Rust for beginners: ownership & lifetimes',
  instructorName: 'Ina Structor',
  issuedAt: new Date('2026-10-24T10:00:00.000Z'),
  verifyUrl: 'http://localhost:3000/certificates/ABCDEFGHJKMNPQRSTVWXYZ0123',
};

describe('newCertificateCode', () => {
  it('is 26 Crockford base32 characters (the DB CHECK pattern)', () => {
    for (let i = 0; i < 200; i++) {
      const code = newCertificateCode();
      expect(code).toHaveLength(CERTIFICATE_CODE_LENGTH);
      expect(code).toMatch(CERTIFICATE_PUBLIC_CODE_PATTERN);
    }
  });

  it('maps the low 5 bits of each random byte', () => {
    const bytes = Buffer.from(Array.from({ length: 26 }, (_, i) => i + 32 * 3));
    expect(newCertificateCode(() => bytes)).toBe('0123456789ABCDEFGHJKMNPQRS');
  });
});

describe('renderCertificatePdf', () => {
  it('loads the bundled DejaVu fonts (TrueType)', () => {
    const { regular, bold } = certificateFonts();
    // sfnt version 0x00010000 = TrueType outlines
    expect(regular.readUInt32BE(0)).toBe(0x00010000);
    expect(bold.readUInt32BE(0)).toBe(0x00010000);
  });

  it('renders a complete PDF, deterministically for the same input', async () => {
    const first = await renderCertificatePdf(INPUT);
    const second = await renderCertificatePdf(INPUT);
    expect(first.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(first.subarray(-6).toString('latin1').trim()).toBe('%%EOF');
    expect(first.equals(second)).toBe(true);
    // The embedded font is a subset, so the file stays small.
    expect(first.length).toBeLessThan(200_000);
  });

  it('a different code renders different bytes', async () => {
    const a = await renderCertificatePdf(INPUT);
    const b = await renderCertificatePdf({ ...INPUT, code: 'ZYXWVTSRQPNMKJHGFEDCBA9876' });
    expect(a.equals(b)).toBe(false);
  });

  it('the QR payload (the verification URL) fits a version the renderer can draw', () => {
    const qr = createQr(INPUT.verifyUrl, { errorCorrectionLevel: 'M' });
    expect(qr.modules.size).toBeGreaterThanOrEqual(21);
    expect(qr.modules.size).toBeLessThanOrEqual(57);
  });
});
