/**
 * Identity emails (design §7), rendered with the shared worker layout (escaped HTML, http(s)
 * links only). Token links carry the token in the URL fragment, so it never reaches server
 * logs, proxies or Referer headers.
 */
import {
  renderMail as render,
  type RenderedMail,
  safeUrl,
  utc,
} from '../../shared/mail/mail-layout';

export { escapeHtml, type RenderedMail } from '../../shared/mail/mail-layout';

/** `${origin}/verify-email#token=…` and `${origin}/reset-password#token=…` (design §7). */
export function tokenLink(
  origin: string,
  path: '/verify-email' | '/reset-password',
  token: string,
): string {
  return `${origin}${path}#token=${encodeURIComponent(token)}`;
}

export function emailVerificationMail(input: {
  displayName: string;
  reason: 'SIGNUP' | 'RESEND';
  link: string;
}): RenderedMail {
  const welcome = input.reason === 'SIGNUP';
  return render({
    subject: welcome ? 'Welcome to Udemy Clone: confirm your email' : 'Confirm your email address',
    greetingName: input.displayName,
    paragraphs: [
      welcome
        ? 'Welcome to Udemy Clone! Please confirm your email address to finish setting up your account.'
        : 'Please confirm your email address.',
      'This link expires in 24 hours and can be used once. Requesting a new email makes earlier links stop working.',
    ],
    action: { label: 'Confirm email address', url: input.link },
    footnote: "If you didn't create an account, you can ignore this email.",
  });
}

export function passwordResetMail(input: { displayName: string; link: string }): RenderedMail {
  return render({
    subject: 'Reset your password',
    greetingName: input.displayName,
    paragraphs: [
      'We received a request to reset the password of your account.',
      'This link expires in 30 minutes and can be used once. Resetting your password signs you out on every device.',
    ],
    action: { label: 'Choose a new password', url: input.link },
    footnote:
      "If you didn't ask for this, you can ignore this email: your password stays the same.",
  });
}

export function accountExistsMail(input: {
  displayName: string;
  loginUrl: string;
  forgotPasswordUrl: string;
}): RenderedMail {
  return render({
    subject: 'You already have an account',
    greetingName: input.displayName,
    paragraphs: [
      'Someone tried to sign up with this email address, but you already have an account.',
      `Sign in at ${safeUrl(input.loginUrl)}. Forgot your password? You can reset it with the link below.`,
    ],
    action: { label: 'Reset your password', url: input.forgotPasswordUrl },
    footnote: "If this wasn't you, no action is needed: nothing has changed on your account.",
  });
}

export function passwordChangedMail(input: {
  displayName: string;
  via: 'RESET' | 'CHANGE';
  changedAt: Date;
  forgotPasswordUrl: string;
}): RenderedMail {
  return render({
    subject: 'Your password was changed',
    greetingName: input.displayName,
    paragraphs: [
      input.via === 'RESET'
        ? `Your password was reset on ${utc(input.changedAt)}, and every device was signed out.`
        : `Your password was changed on ${utc(input.changedAt)}. Your other devices were signed out.`,
      "If this wasn't you, reset your password right away.",
    ],
    action: { label: 'Reset your password', url: input.forgotPasswordUrl },
  });
}

const APP_NAMES: Readonly<Record<string, string>> = {
  student: 'learning',
  instructor: 'instructor',
  admin: 'admin',
};

export function sessionCompromiseMail(input: {
  displayName: string;
  clientApp: string;
  detectedAt: Date;
  forgotPasswordUrl: string;
}): RenderedMail {
  const app = APP_NAMES[input.clientApp] ?? 'Udemy Clone';
  return render({
    subject: 'Security alert: a session was signed out',
    greetingName: input.displayName,
    paragraphs: [
      `On ${utc(input.detectedAt)} we detected that a sign-in token of your ${app} app session was used twice, which can mean it was copied. We signed that session out to protect your account.`,
      "If you don't recognise this, reset your password.",
    ],
    action: { label: 'Reset your password', url: input.forgotPasswordUrl },
  });
}

/** `UserBanned`: the reason (written by an admin) and where to ask about it. */
export function userBannedMail(input: {
  displayName: string;
  reason: string;
  bannedAt: Date;
  supportEmail: string;
}): RenderedMail {
  return render({
    subject: 'Your account has been suspended',
    greetingName: input.displayName,
    paragraphs: [
      `On ${utc(input.bannedAt)} your Udemy Clone account was suspended, and you were signed out on every device. You can't sign in while the suspension is in place.`,
      `Reason: ${input.reason.trim()}`,
      `If you think this is a mistake, contact support at ${input.supportEmail}.`,
    ],
  });
}

/** `UserUnbanned`: access restored, with a link to sign in again. */
export function userUnbannedMail(input: {
  displayName: string;
  liftedAt: Date;
  loginUrl: string;
}): RenderedMail {
  return render({
    subject: 'Your account access has been restored',
    greetingName: input.displayName,
    paragraphs: [
      `On ${utc(input.liftedAt)} the suspension of your Udemy Clone account was lifted. You can sign in again.`,
    ],
    action: { label: 'Sign in', url: input.loginUrl },
  });
}
