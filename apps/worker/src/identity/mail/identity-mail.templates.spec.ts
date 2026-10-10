import { describe, expect, it } from 'vitest';
import {
  accountExistsMail,
  emailVerificationMail,
  escapeHtml,
  passwordChangedMail,
  passwordResetMail,
  sessionCompromiseMail,
  tokenLink,
} from './identity-mail.templates';

const EVIL = `<script>alert("x")</script> & 'Bob'`;
const LINK = 'http://localhost:3000/verify-email#token=abc_DEF-123';

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });
});

describe('tokenLink', () => {
  it('puts the token in the URL fragment', () => {
    expect(tokenLink('http://localhost:3000', '/reset-password', 'abc_DEF-123')).toBe(
      'http://localhost:3000/reset-password#token=abc_DEF-123',
    );
  });
});

describe('identity mail templates', () => {
  const mails = [
    emailVerificationMail({ displayName: EVIL, reason: 'SIGNUP', link: LINK }),
    emailVerificationMail({ displayName: EVIL, reason: 'RESEND', link: LINK }),
    passwordResetMail({ displayName: EVIL, link: LINK }),
    accountExistsMail({
      displayName: EVIL,
      loginUrl: 'http://localhost:3000/login',
      forgotPasswordUrl: 'http://localhost:3000/forgot-password',
    }),
    passwordChangedMail({
      displayName: EVIL,
      via: 'RESET',
      changedAt: new Date('2026-10-10T10:00:00Z'),
      forgotPasswordUrl: 'http://localhost:3000/forgot-password',
    }),
    sessionCompromiseMail({
      displayName: EVIL,
      clientApp: 'student',
      detectedAt: new Date('2026-10-10T10:00:00Z'),
      forgotPasswordUrl: 'http://localhost:3000/forgot-password',
    }),
  ];

  it.each(mails.map((m) => [m.subject, m]))(
    '%s: escapes user input in the HTML part',
    (_s, mail) => {
      expect(mail.html).not.toContain('<script>');
      expect(mail.html).toContain(
        '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Bob&#39;',
      );
      expect(mail.text).toContain(`Hi ${EVIL},`);
      expect(mail.subject).not.toContain('<');
    },
  );

  it('keeps a display name on one line in the text part (no header-like injection)', () => {
    const mail = passwordResetMail({ displayName: 'Eve\r\nBcc: x@evil.test', link: LINK });
    expect(mail.text.split('\n')[0]).toBe('Hi Eve Bcc: x@evil.test,');
  });

  it('renders the token link in both parts', () => {
    const mail = emailVerificationMail({ displayName: 'Jane', reason: 'SIGNUP', link: LINK });
    expect(mail.text).toContain(LINK);
    expect(mail.html).toContain(`href="${LINK}"`);
    expect(mail.subject).toMatch(/Welcome/);
  });

  it('refuses non-http(s) links', () => {
    expect(() =>
      passwordResetMail({ displayName: 'Jane', link: 'javascript:alert(1)//#token=x' }),
    ).toThrow(TypeError);
  });
});
