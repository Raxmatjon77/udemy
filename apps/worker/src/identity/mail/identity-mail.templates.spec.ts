import { describe, expect, it } from 'vitest';
import {
  accountExistsMail,
  emailVerificationMail,
  escapeHtml,
  passwordChangedMail,
  passwordResetMail,
  sessionCompromiseMail,
  tokenLink,
  userBannedMail,
  userUnbannedMail,
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
    userBannedMail({
      displayName: EVIL,
      reason: 'Repeated spam in course Q&A threads.',
      bannedAt: new Date('2026-10-10T10:00:00Z'),
      supportEmail: 'no-reply@udemy.local',
    }),
    userUnbannedMail({
      displayName: EVIL,
      liftedAt: new Date('2026-10-10T10:00:00Z'),
      loginUrl: 'http://localhost:3000/login',
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

  it('escapes the ban reason in the HTML part', () => {
    const mail = userBannedMail({
      displayName: 'Jane',
      reason: EVIL,
      bannedAt: new Date('2026-10-10T10:00:00Z'),
      supportEmail: 'no-reply@udemy.local',
    });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain(
      'Reason: &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Bob&#39;',
    );
    expect(mail.text).toContain('contact support at no-reply@udemy.local.');
  });

  it('refuses a non-http(s) sign-in link in the unban notice', () => {
    expect(() =>
      userUnbannedMail({
        displayName: 'Jane',
        liftedAt: new Date('2026-10-10T10:00:00Z'),
        loginUrl: 'javascript:alert(1)',
      }),
    ).toThrow(TypeError);
  });
});
