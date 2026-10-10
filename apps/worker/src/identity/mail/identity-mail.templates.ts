/**
 * Identity emails (design §7): plain text plus a small HTML alternative. Every interpolated
 * value is escaped for HTML (text and attribute context); links carry the token in the URL
 * fragment, so it never reaches server logs, proxies or Referer headers.
 */

export interface RenderedMail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes text for HTML element content and quoted attribute values. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** Only http(s) links are ever rendered (origins are validated at startup; this is a backstop). */
function safeUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('Email links must be http(s) URLs');
  }
  return parsed.toString();
}

/** Display names are user input: no line breaks in the text part either. */
function oneLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim();
}

function utc(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

interface Layout {
  readonly subject: string;
  readonly greetingName: string;
  readonly paragraphs: readonly string[];
  readonly action?: { readonly label: string; readonly url: string };
  readonly footnote?: string;
}

function render(layout: Layout): RenderedMail {
  const name = oneLine(layout.greetingName);
  const action =
    layout.action === undefined ? undefined : { ...layout.action, url: safeUrl(layout.action.url) };

  const text = [
    `Hi ${name},`,
    '',
    ...layout.paragraphs.flatMap((p) => [p, '']),
    ...(action === undefined ? [] : [`${action.label}: ${action.url}`, '']),
    ...(layout.footnote === undefined ? [] : [layout.footnote, '']),
    '— Udemy Clone',
  ].join('\n');

  const html = [
    '<!doctype html>',
    '<html><body style="font-family:sans-serif;line-height:1.5;color:#1c1d1f">',
    `<p>Hi ${escapeHtml(name)},</p>`,
    ...layout.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`),
    ...(action === undefined
      ? []
      : [
          `<p><a href="${escapeHtml(action.url)}" style="background:#5624d0;color:#fff;padding:10px 16px;text-decoration:none;border-radius:4px">${escapeHtml(action.label)}</a></p>`,
          `<p style="font-size:12px;color:#6a6f73">Or paste this link into your browser:<br>${escapeHtml(action.url)}</p>`,
        ]),
    ...(layout.footnote === undefined
      ? []
      : [`<p style="font-size:12px;color:#6a6f73">${escapeHtml(layout.footnote)}</p>`]),
    '<p>— Udemy Clone</p>',
    '</body></html>',
  ].join('\n');

  return { subject: layout.subject, text, html };
}

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
