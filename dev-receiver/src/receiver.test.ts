import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { generateWebhookSecret, signWebhook } from '@madauth/server/webhook';
import { createReceiver, type ReceiverOptions } from './receiver.js';

const secret = generateWebhookSecret();
let server: Server | undefined;
afterEach(() => server?.close());

/** Starts the receiver on a free port; returns a function that posts a call, signed unless told otherwise. */
async function start(options: Partial<ReceiverOptions> = {}) {
  const lines: string[] = [];
  server = createServer(createReceiver({ secret, log: (l) => lines.push(l), ...options }));
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const send = (type: string, data: Record<string, unknown> | undefined, sign = true) => {
    const body = JSON.stringify({ type, data });
    const id = 'msg_test';
    const timestamp = Math.floor(Date.now() / 1000);
    return fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST',
      headers: {
        'webhook-id': id,
        'webhook-timestamp': String(timestamp),
        'webhook-signature': sign ? signWebhook(secret, id, timestamp, body) : 'v1,forged',
      },
      body,
    });
  };
  return { send, output: () => lines.join('\n') };
}

describe('dev webhook receiver', () => {
  it('prints e-mails with their link and code', async () => {
    const { send, output } = await start();

    const res = await send('email.send_verification', { to: 'ada@example.com', link: 'http://localhost:3000/#madauth_verify=T', code: '123456', site: 'localhost:3000' });

    expect(res.status).toBe(200);
    expect(output()).toContain('E-mail to ada@example.com: Confirm your e-mail address');
    expect(output()).toContain('Link: http://localhost:3000/#madauth_verify=T');
    expect(output()).toContain('Code: 123 456');
  });

  it('prints the sign-in e-mail of the e-mail link with its link and code', async () => {
    const { send, output } = await start();

    const res = await send('email.send_signin_link', { to: 'ada@example.com', link: 'http://localhost:3000/#madauth_signin=T', code: '989624', site: 'localhost:3000' });

    expect(res.status).toBe(200);
    expect(output()).toContain('E-mail to ada@example.com: Sign in (localhost:3000)');
    expect(output()).toContain('Link: http://localhost:3000/#madauth_signin=T');
    expect(output()).toContain('Code: 989 624');
  });

  it('prints an SMS code with its number and what it is for', async () => {
    const { send, output } = await start();

    expect((await send('sms.send_code', { to: '+41791234567', code: '258898', purpose: 'setup', site: 'localhost' })).status).toBe(200);
    expect((await send('sms.send_code', { to: '+41791234567', code: '355069', purpose: 'signin', site: 'localhost' })).status).toBe(200);
    expect((await send('sms.send_code', { to: '+41791234567', code: '000111', purpose: 'approve', site: 'localhost' })).status).toBe(200);

    expect(output()).toContain('SMS to +41791234567: Confirm your phone number (localhost)');
    expect(output()).toContain('Code: 258 898');
    expect(output()).toContain('SMS to +41791234567: Sign in (localhost)');
    expect(output()).toContain('Code: 355 069');
    expect(output()).toContain('SMS to +41791234567: Change your phone number (localhost)');
  });

  it('prints the e-mail for a user who has no password to reset, with how they sign in', async () => {
    const { send, output } = await start();

    const res = await send('email.send_password_reset_no_password', { to: 'ada@example.com', link: 'http://localhost:3000/', site: 'localhost:3000', methods: ['google'] });

    expect(res.status).toBe(200);
    expect(output()).toContain('E-mail to ada@example.com: You have no password to reset (localhost:3000), signs in with: google');
    expect(output()).toContain('Sign in: http://localhost:3000/');
  });

  it('prints the "already registered" e-mail with how the user signs in', async () => {
    const { send, output } = await start();

    const res = await send('email.send_already_registered', { to: 'ada@example.com', link: 'http://localhost:3000/', site: 'localhost:3000', methods: ['google', 'password'] });

    expect(res.status).toBe(200);
    expect(output()).toContain('E-mail to ada@example.com: You already have an account (localhost:3000), signs in with: google, password');
  });

  it('rejects calls without a valid signature', async () => {
    const { send, output } = await start();

    expect((await send('email.send_verification', { to: 'ada@example.com' }, false)).status).toBe(401);
    expect(output()).toContain('wrong signature');
  });

  it('answers the sign-up check, optionally limited to some domains', async () => {
    const { send } = await start({ allowedDomains: ['example.com'] });

    expect(await (await send('user.signing_up', { email: 'ada@example.com' })).json()).toEqual({ allow: true });
    expect(await (await send('user.signing_up', { email: 'x@other.org' })).json()).toEqual({
      allow: false,
      message: 'Only addresses at example.com can sign up.',
    });
  });

  it('prints events', async () => {
    const { send, output } = await start();

    expect((await send('user.signed_in', { user: { id: 'usr_1', email: 'ada@example.com' }, method: 'password' })).status).toBe(204);
    expect(output()).toContain('user.signed_in: ada@example.com (password)');
    expect((await send('user.second_factor_enabled', { user: { id: 'usr_1', email: 'ada@example.com' }, method: 'sms', phone: '+41791234567' })).status).toBe(204);
    expect(output()).toContain('user.second_factor_enabled: ada@example.com (sms, phone: +41791234567)');
    expect((await send('user.signed_up', { user: { id: 'usr_1', email: 'ada@example.com' }, method: 'google' })).status).toBe(204);
    expect(output()).toContain('user.signed_up: ada@example.com (google)');
    expect((await send('user.recovery_code_used', { user: { id: 'usr_1', email: 'ada@example.com' }, remaining: 9 })).status).toBe(204);
    expect(output()).toContain('user.recovery_code_used: ada@example.com (remaining: 9)');
  });

  it('prints claim changes with the address, the claims and who set them', async () => {
    const { send, output } = await start();
    const data = { user: { id: 'usr_1', email: 'ada@example.com' }, by: 'grace@example.com' };

    expect((await send('user.claims_changed', { ...data, claims: { roles: ['admin', 'editor'] } })).status).toBe(204);
    // madAuth before 0.5 sent the address as `email`.
    expect((await send('user.claims_changed', { userId: 'usr_1', email: 'ada@example.com', by: 'grace@example.com', claims: {} })).status).toBe(204);

    expect(output()).toContain('user.claims_changed: ada@example.com now has {"roles":["admin","editor"]} (set by grace@example.com)');
    expect(output()).toContain('user.claims_changed: ada@example.com now has {} (set by grace@example.com)');
  });

  it('understands the names of a madAuth server from before 0.5', async () => {
    const { send, output } = await start({ allowedDomains: ['example.com'] });

    const mail = { to: 'ada@example.com', link: 'http://localhost:3000/#madauth_verify=T', code: '123456', site: 'localhost:3000' };
    const account = { to: 'ada@example.com', link: 'http://localhost:3000/', site: 'localhost:3000', methods: ['google'] };

    // All seven, each down its own path: a wrong entry would end as an event (204, one line) instead.
    for (const [type, data] of [
      ['email.verify', mail],
      ['email.reset', mail],
      ['email.signin', mail],
      ['email.already_registered', account],
      ['email.no_password', account],
      ['sms.code', { to: '+41791234567', code: '258898', purpose: 'setup', site: 'localhost' }],
    ] as const) {
      expect((await send(type, data)).status).toBe(200);
    }
    expect(await (await send('signup.before', { email: 'x@other.org' })).json()).toMatchObject({ allow: false });

    for (const line of [
      'E-mail to ada@example.com: Confirm your e-mail address (localhost:3000)',
      'E-mail to ada@example.com: Reset your password (localhost:3000)',
      'E-mail to ada@example.com: Sign in (localhost:3000)',
      'E-mail to ada@example.com: You already have an account (localhost:3000), signs in with: google',
      'E-mail to ada@example.com: You have no password to reset (localhost:3000), signs in with: google',
      'SMS to +41791234567: Confirm your phone number (localhost)',
      'Sign-up check for x@other.org (password): refused',
    ]) {
      expect(output()).toContain(line);
    }
  });

  it('answers 400 to a signed call without data, and keeps running', async () => {
    const { send } = await start();

    expect((await send('user.signed_in', undefined)).status).toBe(400);
    expect((await send('user.signed_in', { user: { id: 'usr_1' } })).status).toBe(204);
  });

  it("prints a GitHub user's sign-in method in e-mails, the sign-up check and events", async () => {
    const { send, output } = await start();

    expect((await send('email.send_already_registered', { to: 'ada@example.com', link: 'http://localhost:3000/', site: 'localhost:3000', methods: ['github'] })).status).toBe(200);
    expect(await (await send('user.signing_up', { email: 'ada@example.com', method: 'github' })).json()).toEqual({ allow: true });
    expect((await send('user.signed_in', { user: { id: 'usr_1', email: 'ada@example.com' }, method: 'github' })).status).toBe(204);

    expect(output()).toContain('You already have an account (localhost:3000), signs in with: github');
    expect(output()).toContain('Sign-up check for ada@example.com (github): allowed');
    expect(output()).toContain('user.signed_in: ada@example.com (github)');
  });
});
