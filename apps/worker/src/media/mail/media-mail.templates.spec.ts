import { MEDIA_FAILURE_CODES, MEDIA_FAILURE_LABELS } from '@udemy/contracts';
import { describe, expect, it } from 'vitest';
import { processingFailedMail } from './media-mail.templates';

const EVIL = `<script>alert("x")</script> & 'Bob'`;
const ESCAPED = '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Bob&#39;';
const BUILDER = 'http://localhost:3001/courses/0199c8a0-0000-7000-8000-0000000000c1';

describe('processingFailedMail', () => {
  it.each(MEDIA_FAILURE_CODES)('renders the contracts label for %s', (code) => {
    const mail = processingFailedMail({
      displayName: 'Jane',
      purpose: 'LECTURE_VIDEO',
      failureCode: code,
      originalFilename: 'a.mp4',
      placement: null,
      actionUrl: BUILDER,
    });
    expect(mail.text).toContain(`What went wrong: ${MEDIA_FAILURE_LABELS[code]}`);
  });

  it('escapes the filename and titles in HTML and keeps them on one line in text', () => {
    const mail = processingFailedMail({
      displayName: EVIL,
      purpose: 'LECTURE_RESOURCE',
      failureCode: 'INVALID_MEDIA',
      originalFilename: `${EVIL}.pdf`,
      placement: {
        kind: 'lecture',
        courseId: 'c',
        courseTitle: `Course\r\n${EVIL}`,
        lectureTitle: EVIL,
      },
      actionUrl: BUILDER,
    });
    expect(mail.subject).toBe("We couldn't process your resource file");
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain(`Hi ${ESCAPED},`);
    expect(mail.html).toContain(`&quot;${ESCAPED}.pdf&quot;`);
    expect(mail.text).toContain(`in your course "Course ${EVIL}".`);
    expect(mail.html).toContain(`href="${BUILDER}"`);
  });

  it.each(['javascript:alert(1)', 'data:text/html,x'])('refuses the link %s', (url) => {
    expect(() =>
      processingFailedMail({
        displayName: 'Jane',
        purpose: 'LECTURE_VIDEO',
        failureCode: 'TIMEOUT',
        originalFilename: null,
        placement: null,
        actionUrl: url,
      }),
    ).toThrow(TypeError);
  });
});
