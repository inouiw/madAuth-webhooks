import type { LambdaFunctionURLEvent } from 'aws-lambda';
import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { PublishCommand } from '@aws-sdk/client-sns';
import { describe, expect, it, vi } from 'vitest';
import { generateWebhookSecret, signWebhook } from '@madauth/server/webhook';
import { callerFromEnv, createMailer } from './handler.js';

const secret = generateWebhookSecret();

function event(type: string, data: Record<string, unknown> | undefined, options: { sign?: boolean; base64?: boolean } = {}): LambdaFunctionURLEvent {
  const body = JSON.stringify({ type, data });
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    headers: {
      'webhook-id': 'msg_1',
      'webhook-timestamp': String(timestamp),
      'webhook-signature': options.sign === false ? 'v1,forged' : signWebhook(secret, 'msg_1', timestamp, body),
    },
    body: options.base64 ? Buffer.from(body).toString('base64') : body,
    isBase64Encoded: !!options.base64,
  } as unknown as LambdaFunctionURLEvent;
}

function setup(
  sendImpl: (command: unknown) => Promise<unknown> = async () => ({ MessageId: 'm1' }),
  sms?: { publish?: (command: unknown) => Promise<unknown>; senderId?: string },
) {
  const send = vi.fn(sendImpl);
  const publish = vi.fn(sms?.publish ?? (async () => ({ MessageId: 's1' })));
  const handler = createMailer({
    secret,
    from: '"Example" <no-reply@example.com>',
    ses: { send } as never,
    ...(sms ? { sns: { send: publish } as never, smsSenderId: sms.senderId } : {}),
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  return { handler, send, publish };
}

const reset = { to: 'ada@example.com', link: 'https://app.example.com/#madauth_reset=T', code: '123456', site: 'app.example.com' };
const sms = { to: '+41791234567', code: '355069', purpose: 'signin', site: 'app.example.com', locale: 'en', user: { id: 'usr_1' } };

describe('AWS SES mailer', () => {
  it('sends the reset e-mail with link and code, and answers 200', async () => {
    const { handler, send } = setup();

    expect(await handler(event('email.send_password_reset', reset, { base64: true }))).toEqual({ statusCode: 200 });

    expect(send).toHaveBeenCalledOnce();
    const command = send.mock.calls[0][0] as unknown as SendEmailCommand;
    expect(command).toBeInstanceOf(SendEmailCommand);
    const input = command.input;
    expect(input.FromEmailAddress).toBe('"Example" <no-reply@example.com>');
    expect(input.Destination?.ToAddresses).toEqual(['ada@example.com']);
    const content = input.Content!.Simple!;
    expect(content.Subject?.Data).toBe('Reset your password for app.example.com');
    for (const part of [content.Body!.Text!.Data, content.Body!.Html!.Data]) {
      expect(part).toContain(reset.link);
      expect(part).toContain('123 456');
    }
  });

  it('sends the e-mails and SMS of a madAuth server from before 0.5 under their old names', async () => {
    const { handler, send, publish } = setup(undefined, {});
    const account = { to: 'ada@example.com', link: 'https://app.example.com/', site: 'app.example.com', methods: ['google'] };

    for (const [type, data] of [
      ['email.verify', reset],
      ['email.reset', reset],
      ['email.signin', { ...reset, link: 'https://app.example.com/#madauth_signin=T' }],
      ['email.already_registered', account],
      ['email.no_password', account],
      ['sms.code', sms],
    ] as const) {
      expect(await handler(event(type, data))).toEqual({ statusCode: 200 });
    }

    const subjects = send.mock.calls.map((call) => (call[0] as unknown as SendEmailCommand).input.Content!.Simple!.Subject?.Data);
    expect(subjects).toEqual([
      'Confirm your e-mail address for app.example.com',
      'Reset your password for app.example.com',
      'Sign in to app.example.com',
      'You already have an account on app.example.com',
      'You sign in to app.example.com with Google',
    ]);
    expect(publish).toHaveBeenCalledOnce();
  });

  it('answers 502 when SES does not accept the e-mail, so madAuth reports it', async () => {
    const { handler } = setup(async () => {
      throw new Error('MessageRejected: Email address is not verified.');
    });

    expect(await handler(event('email.send_verification', reset))).toEqual({ statusCode: 502 });
  });

  it('rejects a call with a wrong signature and sends nothing', async () => {
    const { handler, send } = setup();

    expect(await handler(event('email.send_password_reset', reset, { sign: false }))).toEqual({ statusCode: 401 });
    expect(send).not.toHaveBeenCalled();
  });

  it('with the secret, also takes a call that AWS checked at an AWS_IAM Function URL, as long as it is signed with the secret', async () => {
    const { handler, send } = setup();

    expect(await handler(withIamCaller(event('email.send_password_reset', reset), MADAUTH_CALLER))).toEqual({ statusCode: 200 });
    expect(await handler(withIamCaller(event('email.send_password_reset', reset, { sign: false }), MADAUTH_CALLER))).toEqual({ statusCode: 401 });
    expect(send).toHaveBeenCalledOnce();
  });

  it('allows the sign-up check and accepts events without sending', async () => {
    const { handler, send } = setup();

    expect(await handler(event('user.signing_up', { email: 'ada@example.com' }))).toEqual({ statusCode: 204 });
    expect(await handler(event('user.signed_up', { user: { id: 'usr_1' } }))).toEqual({ statusCode: 204 });
    expect(send).not.toHaveBeenCalled();
  });

  it('sends the "already registered" e-mail', async () => {
    const { handler, send } = setup();

    await handler(event('email.send_already_registered', { to: 'ada@example.com', link: 'https://app.example.com/', site: 'app.example.com' }));

    const input = (send.mock.calls[0][0] as unknown as SendEmailCommand).input;
    expect(input.Content!.Simple!.Subject?.Data).toBe('You already have an account on app.example.com');
  });

  it('tells a Google user who asked for a reset that there is no password, and how they sign in', async () => {
    const { handler, send } = setup();

    await handler(event('email.send_password_reset_no_password', { to: 'ada@example.com', link: 'https://app.example.com/', site: 'app.example.com', methods: ['google'] }));

    const input = (send.mock.calls[0][0] as unknown as SendEmailCommand).input;
    expect(input.Content!.Simple!.Subject?.Data).toBe('You sign in to app.example.com with Google');
    expect(input.Content!.Simple!.Body!.Text!.Data).toContain('Continue with Google');
  });

  it('tells a Google-only user who is "already registered" to use Google, not "Forgot password?"', async () => {
    const { handler, send } = setup();

    await handler(event('email.send_already_registered', { to: 'ada@example.com', link: 'https://app.example.com/', site: 'app.example.com', methods: ['google'] }));

    const text = (send.mock.calls[0][0] as unknown as SendEmailCommand).input.Content!.Simple!.Body!.Text!.Data!;
    expect(text).toContain('Continue with Google');
    expect(text).not.toContain('Forgot password?');
  });

  it('points to "Forgot password?" when the user has a password, or when an older madAuth sends no methods', async () => {
    const { handler, send } = setup();

    await handler(event('email.send_already_registered', { to: 'ada@example.com', link: 'https://app.example.com/', site: 'app.example.com', methods: ['google', 'password'] }));
    await handler(event('email.send_already_registered', { to: 'ada@example.com', link: 'https://app.example.com/', site: 'app.example.com' }));

    for (const call of send.mock.calls) {
      expect((call[0] as unknown as SendEmailCommand).input.Content!.Simple!.Body!.Text!.Data).toContain('Forgot password?');
    }
  });

  it('names a sign-in method it does not know, and says only "no password" without any', async () => {
    const { handler, send } = setup();

    await handler(event('email.send_password_reset_no_password', { to: 'ada@example.com', link: 'https://app.example.com/', site: 'app.example.com', methods: ['carrier-pigeon'] }));
    await handler(event('email.send_password_reset_no_password', { to: 'ada@example.com', link: 'https://app.example.com/', site: 'app.example.com' }));

    const [withUnknown, without] = send.mock.calls.map((call) => (call[0] as unknown as SendEmailCommand).input.Content!.Simple!);
    expect(withUnknown.Subject?.Data).toBe('You sign in to app.example.com with carrier-pigeon');
    expect(withUnknown.Body!.Text!.Data).toContain('Sign in with carrier-pigeon on the sign-in page.');
    expect(without.Subject?.Data).toBe('Your account on app.example.com has no password');
  });

  it('sends a user who signs in with a passkey alone (e.g. who signed up with one) to the passkey button', async () => {
    const { handler, send } = setup();

    await handler(event('email.send_already_registered', { to: 'ada@example.com', link: 'https://app.example.com/', site: 'app.example.com', methods: ['passkey'] }));
    await handler(event('email.send_password_reset_no_password', { to: 'ada@example.com', link: 'https://app.example.com/', site: 'app.example.com', methods: ['passkey'] }));

    const [registered, noPassword] = send.mock.calls.map((call) => (call[0] as unknown as SendEmailCommand).input.Content!.Simple!);
    expect(registered.Body!.Text!.Data).toContain('Your account has no password: it signs in with a passkey. Use "Sign in with a passkey" on the sign-in page.');
    expect(noPassword.Subject?.Data).toBe('You sign in to app.example.com with a passkey');
  });

  it('sends the sign-in e-mail of the e-mail link with its link and code', async () => {
    const { handler, send } = setup();

    expect(await handler(event('email.send_signin_link', { ...reset, link: 'https://app.example.com/#madauth_signin=T', code: '989624' }))).toEqual({ statusCode: 200 });

    const content = (send.mock.calls[0][0] as unknown as SendEmailCommand).input.Content!.Simple!;
    expect(content.Subject?.Data).toBe('Sign in to app.example.com');
    for (const part of [content.Body!.Text!.Data, content.Body!.Html!.Data]) {
      expect(part).toContain('https://app.example.com/#madauth_signin=T');
      expect(part).toContain('989 624');
      expect(part).toContain('15 minutes');
    }
  });

  it('names the e-mail link and the authenticator app among the ways a user signs in', async () => {
    const { handler, send } = setup();

    await handler(event('email.send_already_registered', { to: 'ada@example.com', link: 'https://app.example.com/', site: 'app.example.com', methods: ['email-link'] }));
    await handler(event('email.send_password_reset_no_password', { to: 'ada@example.com', link: 'https://app.example.com/', site: 'app.example.com', methods: ['authenticator'] }));
    // The app's id before madAuth 0.6, named once also next to the new one.
    await handler(event('email.send_password_reset_no_password', { to: 'ada@example.com', link: 'https://app.example.com/', site: 'app.example.com', methods: ['totp'] }));
    await handler(event('email.send_password_reset_no_password', { to: 'ada@example.com', link: 'https://app.example.com/', site: 'app.example.com', methods: ['totp', 'authenticator'] }));

    const [registered, ...noPassword] = send.mock.calls.map((call) => (call[0] as unknown as SendEmailCommand).input.Content!.Simple!);
    expect(registered.Body!.Text!.Data).toContain('a link sent to this address');
    expect(registered.Body!.Text!.Data).toContain('Choose "Email link" on the sign-in page.');
    for (const mail of noPassword) {
      expect(mail.Subject?.Data).toBe('You sign in to app.example.com with an authenticator app');
      expect(mail.Body!.Text!.Data).toContain('Choose "Authenticator app" on the sign-in page.');
    }
    expect(noPassword).toHaveLength(3);
  });

  it('sends an SMS code with SNS as a transactional message, and answers 200', async () => {
    const { handler, send, publish } = setup(undefined, { senderId: 'Example' });

    expect(await handler(event('sms.send_code', sms))).toEqual({ statusCode: 200 });
    expect(await handler(event('sms.send_code', { ...sms, code: '258898', purpose: 'setup' }))).toEqual({ statusCode: 200 });

    expect(send).not.toHaveBeenCalled();
    const [signIn, setUp] = publish.mock.calls.map((call) => (call[0] as unknown as PublishCommand).input);
    expect(publish.mock.calls[0][0]).toBeInstanceOf(PublishCommand);
    expect(signIn.PhoneNumber).toBe('+41791234567');
    expect(signIn.Message).toBe('355 069 is your code to sign in for app.example.com. It is valid for 10 minutes.');
    expect(signIn.MessageAttributes).toEqual({
      'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' },
      'AWS.SNS.SMS.SenderID': { DataType: 'String', StringValue: 'Example' },
    });
    expect(setUp.Message).toBe('258 898 is your code to confirm your phone number for app.example.com. It is valid for 10 minutes.');
    // Without a sender id, none is sent.
    const plain = setup(undefined, {});
    await plain.handler(event('sms.send_code', { ...sms, purpose: 'approve' }));
    const input = (plain.publish.mock.calls[0][0] as unknown as PublishCommand).input;
    expect(input.Message).toContain('to change your phone number');
    expect(Object.keys(input.MessageAttributes!)).toEqual(['AWS.SNS.SMS.SMSType']);
  });

  it('answers 502 when SNS does not accept the SMS, and 400 when SMS sending is not set up', async () => {
    const refused = setup(undefined, {
      publish: async () => {
        throw new Error('InvalidParameter: phone number');
      },
    });
    expect(await refused.handler(event('sms.send_code', sms))).toEqual({ statusCode: 502 });

    const { handler, publish } = setup();
    expect(await handler(event('sms.send_code', sms))).toEqual({ statusCode: 400 });
    expect(publish).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('SendSms=true'));
  });

  it('answers 400 to an SMS without a number or a code, so no empty SMS goes out and madAuth does not count it as sent', async () => {
    const { handler, publish } = setup(undefined, {});

    expect(await handler(event('sms.send_code', { ...sms, code: undefined }))).toEqual({ statusCode: 400 });
    expect(await handler(event('sms.send_code', { ...sms, to: '' }))).toEqual({ statusCode: 400 });
    expect(publish).not.toHaveBeenCalled();
  });

  it('accepts the e-mail and SMS events without sending anything', async () => {
    const { handler, send, publish } = setup(undefined, {});

    // Events carry `user`, not `to`: also ones this version has not heard of, and the names madAuth used before 0.5.
    for (const type of ['user.email_verified', 'user.password_reset', 'user.second_factor_enabled', 'user.second_factor_disabled', 'user.signed_up', 'email.verified', 'sms.enabled', 'sms.replaced']) {
      expect(await handler(event(type, { user: { id: 'usr_1' }, phone: '+41791234567' }))).toEqual({ statusCode: 204 });
    }
    expect(send).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('answers 400 to an e-mail or SMS type it does not know, so madAuth does not count it as sent', async () => {
    const { handler, send } = setup();

    expect(await handler(event('email.magic_link', { to: 'ada@example.com', link: 'https://app.example.com/' }))).toEqual({ statusCode: 400 });
    expect(await handler(event('sms.magic', { to: '+41791234567' }))).toEqual({ statusCode: 400 });
    expect(send).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('email.magic_link'));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('sms.magic'));
  });

  it('answers 400 to a signed call without data and sends nothing', async () => {
    const { handler, send } = setup();

    expect(await handler(event('email.send_verification', undefined))).toEqual({ statusCode: 400 });
    expect(send).not.toHaveBeenCalled();
  });

  it('tells a GitHub-only user who asked for a reset that there is no password, and to continue with GitHub', async () => {
    const { handler, send } = setup();

    await handler(event('email.send_password_reset_no_password', { to: 'ada@example.com', link: 'https://app.example.com/', site: 'app.example.com', methods: ['github'] }));

    const content = (send.mock.calls[0][0] as unknown as SendEmailCommand).input.Content!.Simple!;
    expect(content.Subject?.Data).toBe('You sign in to app.example.com with GitHub');
    expect(content.Body!.Text!.Data).toContain('your GitHub account');
    expect(content.Body!.Text!.Data).toContain('Continue with GitHub');
  });

  it('tells a GitHub-only user who is "already registered" to use GitHub, not "Forgot password?"', async () => {
    const { handler, send } = setup();

    await handler(event('email.send_already_registered', { to: 'ada@example.com', link: 'https://app.example.com/', site: 'app.example.com', methods: ['github'] }));

    const text = (send.mock.calls[0][0] as unknown as SendEmailCommand).input.Content!.Simple!.Body!.Text!.Data!;
    expect(text).toContain('Continue with GitHub');
    expect(text).not.toContain('Forgot password?');
  });

  it('names both Google and GitHub for a user who signs in with either', async () => {
    const { handler, send } = setup();

    await handler(event('email.send_password_reset_no_password', { to: 'ada@example.com', link: 'https://app.example.com/', site: 'app.example.com', methods: ['google', 'github'] }));

    const content = (send.mock.calls[0][0] as unknown as SendEmailCommand).input.Content!.Simple!;
    expect(content.Subject?.Data).toBe('You sign in to app.example.com with Google or GitHub');
    expect(content.Body!.Text!.Data).toContain('it signs in with your Google account or your GitHub account.');
    expect(content.Body!.Text!.Data).toContain('Use "Continue with Google" or "Continue with GitHub" on the sign-in page.');
    expect(content.Body!.Html!.Data).toContain('your Google account or your GitHub account');
  });

  it('keeps the order of the methods when a button method comes after one with its own action, and names a repeated method once', async () => {
    const { handler, send } = setup();

    await handler(event('email.send_password_reset_no_password', { to: 'ada@example.com', link: 'https://app.example.com/', site: 'app.example.com', methods: ['email-link', 'github', 'github', 'carrier-pigeon'] }));

    const content = (send.mock.calls[0][0] as unknown as SendEmailCommand).input.Content!.Simple!;
    expect(content.Subject?.Data).toBe('You sign in to app.example.com with an e-mail link or GitHub or carrier-pigeon');
    expect(content.Body!.Text!.Data).toContain(
      'Choose "Email link" on the sign-in page. Use "Continue with GitHub" on the sign-in page. Sign in with carrier-pigeon on the sign-in page.',
    );
  });
});

const MADAUTH_ROLE = 'arn:aws:iam::123456789012:role/MadAuthSite-MadAuthFunctionServiceRole-AbC123';
// What AWS passes for a call signed by a Lambda function with that role: the session is the function's name.
const MADAUTH_CALLER = 'arn:aws:sts::123456789012:assumed-role/MadAuthSite-MadAuthFunctionServiceRole-AbC123/MadAuthSite-MadAuthFunction-XyZ789';

/** The call as a Function URL with AWS_IAM auth passes it: with the caller AWS checked, and without madAuth's secret. */
function withIamCaller(call: LambdaFunctionURLEvent, userArn: string): LambdaFunctionURLEvent {
  return { ...call, requestContext: { authorizer: { iam: { accountId: userArn.split(':')[4], userArn } } } } as unknown as LambdaFunctionURLEvent;
}

function iamEvent(type: string, data: Record<string, unknown>, userArn?: string): LambdaFunctionURLEvent {
  const body = JSON.stringify({ type, data });
  const call = { headers: { 'webhook-id': 'msg_1', 'webhook-timestamp': String(Math.floor(Date.now() / 1000)) }, body, isBase64Encoded: false } as unknown as LambdaFunctionURLEvent;
  return userArn === undefined ? call : withIamCaller(call, userArn);
}

describe('AWS SES mailer with AWS IAM (MADAUTH_ROLE_ARN)', () => {
  function setupIam(madauthRoleArn = MADAUTH_ROLE) {
    const send = vi.fn(async () => ({ MessageId: 'm1' }));
    const handler = createMailer({ madauthRoleArn, from: '"Example" <no-reply@example.com>', ses: { send } as never });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    return { handler, send };
  }

  it("sends the e-mail of a call of madAuth's role, which needs no secret", async () => {
    const { handler, send } = setupIam();

    expect(await handler(iamEvent('email.send_password_reset', reset, MADAUTH_CALLER))).toEqual({ statusCode: 200 });
    expect(send).toHaveBeenCalledOnce();
    // The role's path isn't in the caller's ARN: a role with one is known by its account and name too.
    const withPath = setupIam('arn:aws:iam::123456789012:role/service-role/MadAuthSite-MadAuthFunctionServiceRole-AbC123');
    expect(await withPath.handler(iamEvent('email.send_password_reset', reset, MADAUTH_CALLER))).toEqual({ statusCode: 200 });
    // IAM tells roles apart regardless of case, so the role named with other cases is the same one.
    const otherCase = setupIam('arn:aws:iam::123456789012:role/madauthsite-madauthfunctionservicerole-abc123');
    expect(await otherCase.handler(iamEvent('email.send_password_reset', reset, MADAUTH_CALLER))).toEqual({ statusCode: 200 });
  });

  it('refuses a call without AWS IAM authentication, also one signed with a secret: the Function URL has NONE auth', async () => {
    const { handler, send } = setupIam();

    expect(await handler(iamEvent('email.send_password_reset', reset))).toEqual({ statusCode: 401 });
    expect(await handler(event('email.send_password_reset', reset))).toEqual({ statusCode: 401 });
    expect(send).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('the Function URL must have AWS_IAM auth'));
  });

  it('refuses a call of any other caller of the account, and says who called', async () => {
    const { handler, send } = setupIam();

    for (const userArn of [
      // Another role, another account's role of the same name, the same role in another partition, a user, the account.
      'arn:aws:sts::123456789012:assumed-role/Admin/ada',
      'arn:aws:sts::210987654321:assumed-role/MadAuthSite-MadAuthFunctionServiceRole-AbC123/MadAuthSite-MadAuthFunction-XyZ789',
      'arn:aws-cn:sts::123456789012:assumed-role/MadAuthSite-MadAuthFunctionServiceRole-AbC123/MadAuthSite-MadAuthFunction-XyZ789',
      'arn:aws:iam::123456789012:user/ada',
      'arn:aws:iam::123456789012:root',
      // The role's ARN itself, as no caller AWS checked has it.
      MADAUTH_ROLE,
      '',
    ]) {
      expect(await handler(iamEvent('email.send_password_reset', reset, userArn))).toEqual({ statusCode: 403 });
    }
    expect(send).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Rejected a call of arn:aws:sts::123456789012:assumed-role/Admin/ada: only madAuth's role"));
  });

  it('refuses every call with 500 when MADAUTH_ROLE_ARN is no role ARN: a mistake of the setup, not of the caller', async () => {
    for (const arn of ['arn:aws:iam::123456789012:user/madauth', 'arn:aws:iam::123456789012:role/madauth/', 'arn:aws:iam::123456789012:role//madauth', 'madauth']) {
      const { handler, send } = setupIam(arn);

      expect(await handler(iamEvent('email.send_password_reset', reset, 'arn:aws:sts::123456789012:assumed-role/madauth/x'))).toEqual({ statusCode: 500 });
      expect(send).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining("MADAUTH_ROLE_ARN must be a role's ARN"));
    }
  });

  it('takes the caller from MADAUTH_ROLE_ARN or WEBHOOK_SECRET, and refuses both', () => {
    expect(callerFromEnv({ MADAUTH_ROLE_ARN: ` ${MADAUTH_ROLE} ` })).toEqual({ madauthRoleArn: MADAUTH_ROLE });
    expect(callerFromEnv({ WEBHOOK_SECRET: secret, MADAUTH_ROLE_ARN: '' })).toEqual({ secret });
    expect(callerFromEnv({})).toEqual({ secret: '' });
    expect(callerFromEnv({ MADAUTH_ROLE_ARN: MADAUTH_ROLE, WEBHOOK_SECRET: secret })).toEqual({ problem: expect.stringContaining('Remove WEBHOOK_SECRET') });
  });
});
