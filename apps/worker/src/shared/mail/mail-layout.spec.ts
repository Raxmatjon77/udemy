import { describe, expect, it } from 'vitest';
import { mailboxAddress, renderMail, safeUrl } from './mail-layout';

describe('mail layout', () => {
  it('safeUrl accepts http(s) only', () => {
    expect(safeUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeUrl('http://localhost:3001/login')).toBe('http://localhost:3001/login');
    for (const bad of ['javascript:alert(1)', 'mailto:a@b.c', 'data:,x', 'file:///etc/passwd']) {
      expect(() => safeUrl(bad)).toThrow(TypeError);
    }
    expect(() => safeUrl('not a url')).toThrow(TypeError);
  });

  it('renderMail escapes paragraphs and the action label/url', () => {
    const mail = renderMail({
      subject: 's',
      greetingName: 'A',
      paragraphs: ['<i>p</i>'],
      action: { label: '"go"', url: 'http://localhost:3000/x?a=1&b="2"' },
    });
    expect(mail.html).toContain('<p>&lt;i&gt;p&lt;/i&gt;</p>');
    expect(mail.html).toContain('href="http://localhost:3000/x?a=1&amp;b=%222%22"');
    expect(mail.html).toContain('&quot;go&quot;</a>');
  });

  it.each([
    ['Udemy Clone <no-reply@udemy.local>', 'no-reply@udemy.local'],
    ['no-reply@udemy.local', 'no-reply@udemy.local'],
    ['"Support, Team" <help@example.com>', 'help@example.com'],
  ])('mailboxAddress(%s) = %s', (from, address) => {
    expect(mailboxAddress(from)).toBe(address);
  });
});
