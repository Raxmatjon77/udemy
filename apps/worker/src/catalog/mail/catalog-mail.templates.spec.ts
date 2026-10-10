import { describe, expect, it } from 'vitest';
import {
  coursePublishedMail,
  courseRejectedMail,
  courseTakedownMail,
  reviewRequestedMail,
} from './catalog-mail.templates';

const EVIL = `<script>alert("x")</script> & 'Bob'`;
const ESCAPED = '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Bob&#39;';
const URL_ = 'http://localhost:3001/courses/c?a=1&b=2';

describe('catalog mail templates', () => {
  it('escape every user-provided value in HTML and never emit raw markup', () => {
    const mails = [
      reviewRequestedMail({
        adminName: EVIL,
        ownerName: EVIL,
        courseTitle: EVIL,
        kind: 'INITIAL',
        revisionNo: 1,
        submittedAt: new Date('2026-10-10T10:00:00Z'),
        reviewUrl: URL_,
      }),
      coursePublishedMail({
        displayName: EVIL,
        courseTitle: EVIL,
        kind: 'INITIAL',
        builderUrl: URL_,
        publicUrl: 'http://localhost:3000/course/x',
      }),
      courseRejectedMail({
        displayName: EVIL,
        courseTitle: EVIL,
        kind: 'INITIAL',
        reason: `${EVIL} <img src=x onerror=alert(1)>`,
        builderUrl: URL_,
      }),
      courseTakedownMail({
        displayName: EVIL,
        courseTitle: EVIL,
        reason: `${EVIL} <img src=x onerror=alert(1)>`,
        builderUrl: URL_,
      }),
    ];
    for (const mail of mails) {
      expect(mail.html).not.toContain('<script>');
      expect(mail.html).not.toContain('<img');
      expect(mail.html).toContain(`Hi ${ESCAPED},`);
      expect(mail.html).toContain('href="http://localhost:3001/courses/c?a=1&amp;b=2"');
    }
    expect(mails[2]?.text).toContain(`Reason: ${EVIL} <img src=x onerror=alert(1)>\n`);
  });

  it('keep titles and names on one line (no header or line injection)', () => {
    const mail = reviewRequestedMail({
      adminName: 'Ann\r\nBcc: x@evil.test',
      ownerName: 'Eve\nX',
      courseTitle: 'Title\r\nInjected',
      kind: 'UPDATE',
      revisionNo: 3,
      submittedAt: new Date('2026-10-10T10:00:00Z'),
      reviewUrl: URL_,
    });
    expect(mail.subject).toBe('Review requested: "Title Injected"');
    expect(mail.text.split('\n')[0]).toBe('Hi Ann Bcc: x@evil.test,');
    expect(mail.text).toContain(
      'Eve X submitted an update to the published course "Title Injected"',
    );
  });

  it.each(['javascript:alert(1)', 'data:text/html,x', 'ftp://example.com'])(
    'refuse the non-http(s) link %s',
    (url) => {
      expect(() =>
        courseTakedownMail({
          displayName: 'J',
          courseTitle: 'T',
          reason: 'r'.repeat(10),
          builderUrl: url,
        }),
      ).toThrow(TypeError);
      expect(() =>
        reviewRequestedMail({
          adminName: 'A',
          ownerName: null,
          courseTitle: 'T',
          kind: 'INITIAL',
          revisionNo: 1,
          submittedAt: new Date(),
          reviewUrl: url,
        }),
      ).toThrow(TypeError);
    },
  );
});
