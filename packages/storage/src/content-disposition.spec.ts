import { describe, expect, it } from 'vitest';
import { attachmentContentDisposition } from './content-disposition';

describe('attachmentContentDisposition', () => {
  it('is a bare attachment without a usable filename', () => {
    expect(attachmentContentDisposition()).toBe('attachment');
    expect(attachmentContentDisposition('   ')).toBe('attachment');
  });

  it('emits an ASCII fallback plus an RFC 5987 filename*', () => {
    expect(attachmentContentDisposition('Résumé "final".pdf')).toBe(
      `attachment; filename="R_sum_ _final_.pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%22final%22.pdf`,
    );
    expect(attachmentContentDisposition("it's (1)*.zip")).toBe(
      `attachment; filename="it's (1)*.zip"; filename*=UTF-8''it%27s%20%281%29%2A.zip`,
    );
  });

  it('cannot inject headers or paths', () => {
    const value = attachmentContentDisposition('a\r\nSet-Cookie: x=1/../b\\c.pdf');
    expect(value).not.toMatch(/[\r\n]/);
    expect(value).toContain('filename="a__Set-Cookie: x=1_.._b_c.pdf"');
  });
});
