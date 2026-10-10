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

    const res = await send('email.verify', { to: 'ada@example.com', link: 'http://localhost:3000/#madauth_verify=T', code: '123456', site: 'localhost:3000' });

    expect(res.status).toBe(200);
    expect(output()).toContain('E-mail to ada@example.com: Confirm your e-mail address');
    expect(output()).toContain('Link: http://localhost:3000/#madauth_verify=T');
    expect(output()).toContain('Code: 123 456');
  });

  it('prints the e-mail for a user who has no password to reset, with how they sign in', async () => {
    const { send, output } = await start();

    const res = await send('email.no_password', { to: 'ada@example.com', link: 'http://localhost:3000/', site: 'localhost:3000', methods: ['google'] });

    expect(res.status).toBe(200);
    expect(output()).toContain('E-mail to ada@example.com: You have no password to reset (localhost:3000), signs in with: google');
    expect(output()).toContain('Sign in: http://localhost:3000/');
  });

  it('rejects calls without a valid signature', async () => {
    const { send, output } = await start();

    expect((await send('email.verify', { to: 'ada@example.com' }, false)).status).toBe(401);
    expect(output()).toContain('wrong signature');
  });

  it('answers the sign-up check, optionally limited to some domains', async () => {
    const { send } = await start({ allowedDomains: ['example.com'] });

    expect(await (await send('signup.before', { email: 'ada@example.com' })).json()).toEqual({ allow: true });
    expect(await (await send('signup.before', { email: 'x@other.org' })).json()).toEqual({
      allow: false,
      message: 'Only addresses at example.com can sign up.',
    });
  });

  it('prints events', async () => {
    const { send, output } = await start();

    expect((await send('user.signed_in', { user: { id: 'usr_1', email: 'ada@example.com' }, method: 'password' })).status).toBe(204);
    expect(output()).toContain('user.signed_in: ada@example.com (password)');
  });

  it('prints claim changes with the address, the claims and who set them', async () => {
    const { send, output } = await start();
    const data = { userId: 'usr_1', email: 'ada@example.com', by: 'grace@example.com' };

    expect((await send('user.claims_changed', { ...data, claims: { roles: ['admin', 'editor'] } })).status).toBe(204);
    expect((await send('user.claims_changed', { ...data, claims: {} })).status).toBe(204);

    expect(output()).toContain('user.claims_changed: ada@example.com now has {"roles":["admin","editor"]} (set by grace@example.com)');
    expect(output()).toContain('user.claims_changed: ada@example.com now has {} (set by grace@example.com)');
  });

  it('answers 400 to a signed call without data, and keeps running', async () => {
    const { send } = await start();

    expect((await send('user.signed_in', undefined)).status).toBe(400);
    expect((await send('user.signed_in', { user: { id: 'usr_1' } })).status).toBe(204);
  });
});
