// The e-mails and SMS madAuth asks for, as plain text and HTML. Edit the wording here, or use `locale` to translate.

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A 6-digit code as it is shown: `513 416`. */
const spaceCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

function render(opts: { to: string; subject: string; intro: string; link: string; action: string; code?: string; outro: string }): Mail {
  const spacedCode = opts.code ? spaceCode(opts.code) : undefined;
  const text = [
    opts.intro,
    '',
    `${opts.action}: ${opts.link}`,
    ...(spacedCode ? ['', `Or enter this code: ${spacedCode}`] : []),
    '',
    opts.outro,
  ].join('\n');
  const html = `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">
<p>${escapeHtml(opts.intro)}</p>
<p><a href="${escapeHtml(opts.link)}" style="display:inline-block;padding:10px 18px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none">${escapeHtml(opts.action)}</a></p>
${spacedCode ? `<p>Or enter this code:</p><p style="font-size:24px;font-weight:600;letter-spacing:4px">${escapeHtml(spacedCode)}</p>` : ''}
<p style="color:#555">${escapeHtml(opts.outro)}</p>
</body></html>`;
  return { to: opts.to, subject: opts.subject, text, html };
}

export function verifyEmailMail(to: string, site: string, link: string, code: string): Mail {
  return render({
    to,
    subject: `Confirm your e-mail address for ${site}`,
    intro: `Please confirm your e-mail address to finish creating your account on ${site}.`,
    action: 'Confirm e-mail address',
    link,
    code,
    outro: 'The link and the code are valid for 24 hours. If you did not create an account, ignore this e-mail.',
  });
}

export function resetPasswordMail(to: string, site: string, link: string, code: string): Mail {
  return render({
    to,
    subject: `Reset your password for ${site}`,
    intro: `Someone asked to reset the password of your account on ${site}.`,
    action: 'Choose a new password',
    link,
    code,
    outro: 'The link and the code are valid for 30 minutes. If you did not ask for this, ignore this e-mail; your password stays the same.',
  });
}

/** The sign-in e-mail of the passwordless e-mail link: the link signs in, the code too. */
export function signInMail(to: string, site: string, link: string, code: string): Mail {
  return render({
    to,
    subject: `Sign in to ${site}`,
    intro: `Use this link to sign in to ${site}. If you read this on another device, enter the code instead.`,
    action: `Sign in to ${site}`,
    link,
    code,
    outro: 'The link and the code are valid for 15 minutes and work once. If you did not ask to sign in, ignore this e-mail; nobody can sign in without it.',
  });
}

/** What to tell a user about one of their sign-in methods, by madAuth's method id: its button on the sign-in page, or else what to do there. An unknown id is named as it is. */
function describeMethod(method: string): { name: string; label: string; button?: string; action?: string } {
  if (method === 'google') return { name: 'Google', label: 'your Google account', button: 'Continue with Google' };
  if (method === 'github') return { name: 'GitHub', label: 'your GitHub account', button: 'Continue with GitHub' };
  if (method === 'email-link') return { name: 'an e-mail link', label: 'a link sent to this address', action: 'Choose "E-mail link" on the sign-in page.' };
  if (method === 'totp') return { name: 'an authenticator app', label: 'a code from your authenticator app', action: 'Choose "Authenticator app" on the sign-in page.' };
  return { name: method, label: method };
}

/**
 * How a user without a password signs in, from madAuth's `methods` (e.g. `["google"]`), for the e-mails
 * that say so. Null if the methods are unknown (an older madAuth) or include a password.
 */
function passwordlessHint(methods: string[]): { names: string; labels: string; actions: string } | null {
  if (!methods.length || methods.includes('password')) return null;
  const described = methods.map(describeMethod);
  const buttons = described.flatMap((d) => (d.button ? [`"${d.button}"`] : []));
  const actions = [
    ...(buttons.length ? [`Use ${buttons.join(' or ')} on the sign-in page.`] : []),
    ...described.filter((d) => !d.button).map((d) => d.action ?? `Sign in with ${d.name} on the sign-in page.`),
  ];
  return {
    names: described.map((d) => d.name).join(' or '),
    labels: described.map((d) => d.label).join(' or '),
    actions: actions.join(' '),
  };
}

/** `methods` is how the user signs in, as madAuth sends it (e.g. `["google"]`); a user without a password is sent there. */
export function alreadyRegisteredMail(to: string, site: string, link: string, methods: string[] = []): Mail {
  const hint = passwordlessHint(methods);
  return render({
    to,
    subject: `You already have an account on ${site}`,
    intro: `Someone tried to create an account on ${site} with this e-mail address, but you already have one.`,
    action: `Sign in to ${site}`,
    link,
    outro: hint
      ? `Your account has no password: it signs in with ${hint.labels}. ${hint.actions} If this was not you, ignore this e-mail.`
      : 'If you forgot your password, use "Forgot password?" when signing in. If this was not you, ignore this e-mail.',
  });
}

/**
 * The SMS with a code, short enough for one message segment. `purpose` is what the code is for, as madAuth sends it:
 * `setup` (confirming a new number), `signin` (the second step of a sign-in) or `approve` (a change to the number).
 */
export function smsText(site: string, code: string, purpose: string | undefined): string {
  const what = purpose === 'setup' ? 'to confirm your phone number' : purpose === 'approve' ? 'to change your phone number' : 'to sign in';
  return `${spaceCode(code)} is your code ${what} for ${site}. It is valid for 10 minutes.`;
}

/** "Forgot password?" for a user without a password: madAuth sends no reset, the user is told how they sign in. */
export function noPasswordMail(to: string, site: string, link: string, methods: string[] = []): Mail {
  const hint = passwordlessHint(methods);
  return render({
    to,
    subject: hint ? `You sign in to ${site} with ${hint.names}` : `Your account on ${site} has no password`,
    intro: `You asked to reset your password on ${site}, but your account has no password${hint ? `: it signs in with ${hint.labels}.` : '.'}`,
    action: `Sign in to ${site}`,
    link,
    outro: `${hint ? `${hint.actions} ` : ''}If this was not you, ignore this e-mail.`,
  });
}
