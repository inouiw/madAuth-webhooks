import type { IncomingMessage, ServerResponse } from 'node:http';
import { verifyWebhook } from '@madauth/server/webhook';

export interface ReceiverOptions {
  /** The same WEBHOOK_SECRET madAuth uses. */
  secret: string;
  /** If set, only these e-mail domains may sign up (answers signup.before). */
  allowedDomains?: string[];
  /** Where to print; the terminal by default. */
  log?: (line: string) => void;
}

interface Call {
  type: string;
  data: Record<string, any>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/** The names madAuth used before 0.5 for the calls this receiver answers, and their names now: both work. */
const LEGACY_TYPES: Record<string, string> = {
  'email.verify': 'email.send_verification',
  'email.reset': 'email.send_password_reset',
  'email.signin': 'email.send_signin_link',
  'email.already_registered': 'email.send_already_registered',
  'email.no_password': 'email.send_password_reset_no_password',
  'sms.code': 'sms.send_code',
  'signup.before': 'user.signing_up',
};

/** The parsed call, or null if the body is not a JSON object with a string `type` and an object `data`. */
function parseCall(body: string): Call | null {
  try {
    const call = JSON.parse(body) as Call | null;
    if (!call || typeof call.type !== 'string' || !call.data || typeof call.data !== 'object') return null;
    return { ...call, type: LEGACY_TYPES[call.type] ?? call.type };
  } catch {
    return null;
  }
}

/** A 6-digit code as it is shown: `513 416`. */
const spaced = (code: unknown) => `${String(code ?? '').slice(0, 3)} ${String(code ?? '').slice(3)}`;

/** Handles madAuth's webhook calls: prints e-mails, SMS and events, and answers the sign-up check. */
export function createReceiver(options: ReceiverOptions) {
  const log = options.log ?? ((line: string) => console.log(line));

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const reply = (status: number, body?: unknown) => {
      res.writeHead(status, body === undefined ? {} : { 'Content-Type': 'application/json' });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (req.method !== 'POST') return reply(405);

    // Verify the raw body exactly as it arrived: re-serialized JSON would not match the signature.
    let body: string;
    try {
      body = await readBody(req);
    } catch {
      return; // The client went away mid-request; there is no one to answer.
    }
    if (!verifyWebhook(options.secret, req.headers, body)) {
      log('[webhook] Rejected a call with a wrong signature. Do madAuth and this receiver use the same WEBHOOK_SECRET?');
      return reply(401);
    }
    const call = parseCall(body);
    if (!call) {
      log('[webhook] Rejected a call whose body is not {"type": ..., "data": {...}}.');
      return reply(400);
    }
    const { type, data } = call;

    if (type === 'email.send_verification' || type === 'email.send_password_reset' || type === 'email.send_signin_link') {
      const what = type === 'email.send_verification' ? 'Confirm your e-mail address' : type === 'email.send_password_reset' ? 'Reset your password' : 'Sign in';
      log(`\n[webhook] E-mail to ${data.to}: ${what} (${data.site})`);
      log(`  Link: ${data.link}`);
      log(`  Code: ${spaced(data.code)}\n`);
      return reply(200);
    }
    if (type === 'sms.send_code') {
      // What the code is for: confirming a new number, the second step of a sign-in, or approving a change to the number.
      const what = data.purpose === 'setup' ? 'Confirm your phone number' : data.purpose === 'approve' ? 'Change your phone number' : 'Sign in';
      log(`\n[webhook] SMS to ${data.to}: ${what} (${data.site})`);
      log(`  Code: ${spaced(data.code)}\n`);
      return reply(200);
    }
    if (type === 'email.send_already_registered' || type === 'email.send_password_reset_no_password') {
      const what = type === 'email.send_password_reset_no_password' ? 'You have no password to reset' : 'You already have an account';
      const methods = Array.isArray(data.methods) ? data.methods.map(String).join(', ') : '';
      log(`\n[webhook] E-mail to ${data.to}: ${what} (${data.site})${methods ? `, signs in with: ${methods}` : ''}`);
      log(`  Sign in: ${data.link}\n`);
      return reply(200);
    }
    if (type === 'user.signing_up') {
      const domain = String(data.email).split('@').pop()!.toLowerCase();
      const allowed = !options.allowedDomains?.length || options.allowedDomains.includes(domain);
      log(`[webhook] Sign-up check for ${data.email} (${data.method ?? 'password'}): ${allowed ? 'allowed' : 'refused'}`);
      return reply(200, allowed ? { allow: true } : { allow: false, message: `Only addresses at ${options.allowedDomains!.join(', ')} can sign up.` });
    }
    if (type === 'user.claims_changed') {
      // madAuth 0.5 sends the user; before, their address as `email`.
      log(`[webhook] user.claims_changed: ${data.user?.email ?? data.email} now has ${JSON.stringify(data.claims ?? {})} (set by ${data.by})`);
      return reply(204);
    }
    // What else the event says: how they signed in (`password`), and the other fields as `phone: +41…`, `by: admin@…`.
    const details = Object.entries(data)
      .filter(([key, value]) => key !== 'user' && value != null && typeof value !== 'object')
      .map(([key, value]) => (key === 'method' || key === 'via' ? String(value) : `${key}: ${value}`));
    log(`[webhook] ${type}: ${data.user?.email ?? data.user?.id ?? ''}${details.length ? ` (${details.join(', ')})` : ''}`);
    return reply(204);
  };
}
