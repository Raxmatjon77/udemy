/**
 * Instructor-application decision emails (design §7), rendered with the shared worker layout:
 * every interpolated value (display name, the admin's reason) is HTML-escaped and only
 * http(s) links are rendered.
 */
import { type RenderedMail, renderMail } from '../../shared/mail/mail-layout';

export function instructorApplicationApprovedMail(input: {
  displayName: string;
  instructorLoginUrl: string;
}): RenderedMail {
  return renderMail({
    subject: "You're now an instructor",
    greetingName: input.displayName,
    paragraphs: [
      'Good news: your instructor application was approved. You can now sign in to the instructor app with your usual email and password and start creating courses.',
    ],
    action: { label: 'Open the instructor app', url: input.instructorLoginUrl },
  });
}

export function instructorApplicationRejectedMail(input: {
  displayName: string;
  reason: string;
  becomeInstructorUrl: string;
}): RenderedMail {
  return renderMail({
    subject: 'Your instructor application was not approved',
    greetingName: input.displayName,
    paragraphs: [
      'Thank you for applying to teach on Udemy Clone. After reviewing your application, we could not approve it this time.',
      `Reason: ${input.reason.trim()}`,
      'You are welcome to address the points above and apply again.',
    ],
    action: { label: 'Apply again', url: input.becomeInstructorUrl },
  });
}
