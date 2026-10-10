import { describe, expect, it } from 'vitest';
import {
  instructorApplicationApprovedMail,
  instructorApplicationRejectedMail,
} from './users-mail.templates';

const EVIL = `<script>alert("x")</script> & 'Bob'`;
const ESCAPED = '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Bob&#39;';
const INSTRUCTOR_LOGIN = 'http://localhost:3001/login';
const BECOME_INSTRUCTOR = 'http://localhost:3000/become-instructor';

describe('users mail templates', () => {
  it('approved: subject, instructor-app link in both parts, escaped name', () => {
    const mail = instructorApplicationApprovedMail({
      displayName: EVIL,
      instructorLoginUrl: INSTRUCTOR_LOGIN,
    });
    expect(mail.subject).toBe("You're now an instructor");
    expect(mail.text).toContain(`Open the instructor app: ${INSTRUCTOR_LOGIN}`);
    expect(mail.html).toContain(`href="${INSTRUCTOR_LOGIN}"`);
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain(`Hi ${ESCAPED},`);
  });

  it('rejected: the reason is escaped in HTML, verbatim in text, with the re-apply link', () => {
    const mail = instructorApplicationRejectedMail({
      displayName: 'Jane',
      reason: `  ${EVIL} <img src=x onerror=alert(1)>  `,
      becomeInstructorUrl: BECOME_INSTRUCTOR,
    });
    expect(mail.subject).toBe('Your instructor application was not approved');
    expect(mail.text).toContain(`Reason: ${EVIL} <img src=x onerror=alert(1)>\n`);
    expect(mail.html).toContain(`<p>Reason: ${ESCAPED} &lt;img src=x onerror=alert(1)&gt;</p>`);
    expect(mail.html).not.toContain('<img');
    expect(mail.html).not.toContain('<script>');
    expect(mail.text).toContain(`Apply again: ${BECOME_INSTRUCTOR}`);
    expect(mail.html).toContain(`href="${BECOME_INSTRUCTOR}"`);
  });

  it('keeps the display name on one line in the text part', () => {
    const mail = instructorApplicationApprovedMail({
      displayName: 'Eve\r\nBcc: x@evil.test',
      instructorLoginUrl: INSTRUCTOR_LOGIN,
    });
    expect(mail.text.split('\n')[0]).toBe('Hi Eve Bcc: x@evil.test,');
  });

  it.each(['javascript:alert(1)', 'data:text/html,<b>x</b>', 'ftp://example.com/login'])(
    'refuses the non-http(s) link %s',
    (url) => {
      expect(() =>
        instructorApplicationApprovedMail({ displayName: 'Jane', instructorLoginUrl: url }),
      ).toThrow(TypeError);
      expect(() =>
        instructorApplicationRejectedMail({
          displayName: 'Jane',
          reason: 'Not enough detail in the bio.',
          becomeInstructorUrl: url,
        }),
      ).toThrow(TypeError);
    },
  );
});
