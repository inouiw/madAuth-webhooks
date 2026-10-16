// A madAuth webhook receiver on AWS Lambda (Function URL): sends madAuth's e-mails with Amazon SES and its
// SMS codes with Amazon SNS. It answers 200 only after SES or SNS has accepted a message, so madAuth knows
// whether it went out. It takes calls signed with WEBHOOK_SECRET or, behind a Function URL with AWS_IAM auth, only
// those of madAuth's role (MADAUTH_ROLE_ARN).
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { verifyWebhook } from '@madauth/server/webhook';
import type { LambdaFunctionURLEvent, LambdaFunctionURLEventWithIAMAuthorizer, LambdaFunctionURLResult } from 'aws-lambda';
import { alreadyRegisteredMail, noPasswordMail, resetPasswordMail, signInMail, smsText, type Mail, verifyEmailMail } from './templates.js';

/**
 * Who may call: whoever signs the calls with the secret, or, behind a Function URL with AWS_IAM auth, madAuth's role
 * only. AWS checks the role's signature before this function runs, so no secret is needed.
 */
export type Caller =
  /** The same WEBHOOK_SECRET madAuth uses. */
  | { secret: string }
  /** The ARN of the role madAuth signs its calls with (WEBHOOK_AUTH=aws-iam), e.g. `arn:aws:iam::123456789012:role/madauth-server`. */
  | { madauthRoleArn: string };

export type MailerOptions = Caller & {
  /** Sender, e.g. `"Example" <no-reply@example.com>`; its domain must be verified in SES. */
  from: string;
  /** Optional SES configuration set, e.g. to record bounces and complaints. */
  configurationSet?: string;
  ses: Pick<SESv2Client, 'send'>;
  /** Sends the SMS codes (`sms.send_code`). Without it, an SMS is answered with an error, so madAuth reports it. */
  sns?: Pick<SNSClient, 'send'>;
  /** Optional sender name shown instead of a number, where carriers support it (SNS `AWS.SNS.SMS.SenderID`). */
  smsSenderId?: string;
};

/** A role's partition, account and name. An assumed role's ARN has no path, so a role is known by these. */
interface Role {
  partition: string;
  account: string;
  name: string;
}

// IAM's characters of role names and path segments.
const NAME = String.raw`[\w+=,.@-]+`;
const ROLE_ARN = new RegExp(String.raw`^arn:([\w-]+):iam::(\d{12}):role/(?:${NAME}/)*(${NAME})$`);
const ASSUMED_ROLE_ARN = new RegExp(String.raw`^arn:([\w-]+):sts::(\d{12}):assumed-role/(${NAME})/[^/]+$`);

/** The role of an ARN that matches `pattern` (partition, account and name in that order), or null. */
function roleOf(pattern: RegExp, arn: string): Role | null {
  const match = pattern.exec(arn);
  return match ? { partition: match[1]!, account: match[2]!, name: match[3]! } : null;
}

// Role names are unique regardless of case, so a role named with other cases is still the same role.
const sameRole = (a: Role, b: Role): boolean => a.partition === b.partition && a.account === b.account && a.name.toLowerCase() === b.name.toLowerCase();

/** How a call is checked, made once from the options: a malformed MADAUTH_ROLE_ARN refuses every call with 500. */
type Gate = { secret: string } | { role: Role; arn: string } | { problem: string };

function gateOf(caller: Caller): Gate {
  if (!('madauthRoleArn' in caller)) return { secret: caller.secret };
  const role = roleOf(ROLE_ARN, caller.madauthRoleArn);
  return role
    ? { role, arn: caller.madauthRoleArn }
    : { problem: `MADAUTH_ROLE_ARN must be a role's ARN, e.g. arn:aws:iam::123456789012:role/madauth-server, but is "${caller.madauthRoleArn}".` };
}

type IamRequestContext = Partial<Pick<LambdaFunctionURLEventWithIAMAuthorizer['requestContext'], 'authorizer'>>;

/** The caller AWS checked at a Function URL with AWS_IAM auth (`requestContext.authorizer.iam`); undefined without one. */
function iamCallerOf(event: LambdaFunctionURLEvent): { userArn: string } | undefined {
  const iam = (event.requestContext as IamRequestContext | undefined)?.authorizer?.iam;
  return iam ? { userArn: typeof iam.userArn === 'string' ? iam.userArn : '' } : undefined;
}

/** Whether a call is madAuth's; if not, the answer and what the log says. */
function checkCaller(gate: Gate, event: LambdaFunctionURLEvent, body: string): { ok: true } | { ok: false; statusCode: 401 | 403 | 500; log: string } {
  if ('problem' in gate) return { ok: false, statusCode: 500, log: gate.problem };
  if ('role' in gate) {
    const iam = iamCallerOf(event);
    if (!iam) {
      return { ok: false, statusCode: 401, log: 'Rejected a call without AWS IAM authentication: with MADAUTH_ROLE_ARN, the Function URL must have AWS_IAM auth.' };
    }
    const caller = roleOf(ASSUMED_ROLE_ARN, iam.userArn);
    if (!caller || !sameRole(caller, gate.role)) {
      return { ok: false, statusCode: 403, log: `Rejected a call of ${iam.userArn || 'an unknown caller'}: only madAuth's role ${gate.arn} (MADAUTH_ROLE_ARN) may call.` };
    }
    return { ok: true };
  }
  if (!verifyWebhook(gate.secret, event.headers, body)) {
    return { ok: false, statusCode: 401, log: 'Rejected a call with a wrong signature. Do madAuth and this function use the same WEBHOOK_SECRET?' };
  }
  return { ok: true };
}

interface Call {
  type: string;
  data: Record<string, any>;
}

/**
 * The names madAuth used before 0.5, and their names now. Both work, so this function can be deployed before
 * a madAuth server is upgraded, and still sends the e-mails of one that isn't yet.
 */
const LEGACY_TYPES: Record<string, string> = {
  'email.verify': 'email.send_verification',
  'email.reset': 'email.send_password_reset',
  'email.signin': 'email.send_signin_link',
  'email.already_registered': 'email.send_already_registered',
  'email.no_password': 'email.send_password_reset_no_password',
  'sms.code': 'sms.send_code',
};

/** How the user signs in, from the call's `methods` (e.g. `["google"]`); empty when the call has none. */
const methodsOf = (data: Record<string, any>): string[] => (Array.isArray(data.methods) ? data.methods.map(String) : []);

/**
 * Whether a call is a message to send (an e-mail or an SMS, which carry `to`) rather than an event (madAuth before
 * 0.5 named some `email.verified`, `sms.enabled`, …; they carry `user`): only a message this function can't send is an error.
 */
const isMessage = ({ type, data }: Call): boolean => (type.startsWith('email.') || type.startsWith('sms.')) && typeof data.to === 'string';

/** The e-mail for a webhook call, or null if the call is not an e-mail. */
function mailFor({ type, data }: Call): Mail | null {
  switch (type) {
    case 'email.send_verification':
      return verifyEmailMail(data.to, data.site, data.link, data.code);
    case 'email.send_password_reset':
      return resetPasswordMail(data.to, data.site, data.link, data.code);
    case 'email.send_signin_link':
      return signInMail(data.to, data.site, data.link, data.code);
    case 'email.send_already_registered':
      return alreadyRegisteredMail(data.to, data.site, data.link, methodsOf(data));
    case 'email.send_password_reset_no_password':
      return noPasswordMail(data.to, data.site, data.link, methodsOf(data));
    default:
      return null;
  }
}

export function createMailer(options: MailerOptions) {
  const gate = gateOf(options);
  return async (event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> => {
    // Verify the raw body exactly as it arrived: re-serialized JSON would not match the signature.
    const body = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
    const check = checkCaller(gate, event, body);
    if (!check.ok) {
      (check.statusCode === 500 ? console.error : console.warn)(check.log);
      return { statusCode: check.statusCode };
    }
    let call: Call | null;
    try {
      call = JSON.parse(body) as Call | null;
    } catch {
      return { statusCode: 400 };
    }
    if (!call || typeof call.type !== 'string' || !call.data || typeof call.data !== 'object') return { statusCode: 400 };
    call = { ...call, type: LEGACY_TYPES[call.type] ?? call.type };

    if (call.type === 'sms.send_code') return sendSms(options, call.data);

    const mail = mailFor(call);
    if (!mail) {
      // An e-mail or SMS this version doesn't know: not 2xx, so madAuth doesn't count it as sent but tells the
      // user that it can't be sent right now, and the server's log says what to update.
      if (isMessage(call)) {
        console.error(`Unknown e-mail or SMS type "${call.type}": update this function, or take the type out of the madAuth server's WEBHOOK_EVENTS.`);
        return { statusCode: 400 };
      }
      // Other calls (the sign-up check, events) are not this function's business: an empty 2xx allows them.
      return { statusCode: 204 };
    }

    try {
      await options.ses.send(
        new SendEmailCommand({
          FromEmailAddress: options.from,
          Destination: { ToAddresses: [mail.to] },
          Content: {
            Simple: {
              Subject: { Data: mail.subject, Charset: 'UTF-8' },
              Body: { Text: { Data: mail.text, Charset: 'UTF-8' }, Html: { Data: mail.html, Charset: 'UTF-8' } },
            },
          },
          ConfigurationSetName: options.configurationSet,
        }),
      );
    } catch (e) {
      // Not 2xx: madAuth then tells the user that e-mails can't be sent right now.
      console.error(`SES did not accept "${mail.subject}" to ${mail.to}:`, e);
      return { statusCode: 502 };
    }
    return { statusCode: 200 };
  };
}

/** Hands an SMS code to SNS as a transactional message; 200 once SNS accepted it. */
async function sendSms(options: MailerOptions, data: Record<string, any>): Promise<LambdaFunctionURLResult> {
  if (!options.sns) {
    console.error('An SMS code arrived, but SMS sending is not set up: deploy with SendSms=true, or take sms.send_code (sms.code before madAuth 0.5) out of the madAuth server\'s WEBHOOK_EVENTS.');
    return { statusCode: 400 };
  }
  const to = String(data.to ?? '');
  const code = String(data.code ?? '');
  if (!to || !code) {
    // Not 2xx: an SMS without a number or a code must not count as sent (and SNS would send an empty code).
    console.error(`An SMS code arrived without ${to ? 'a code' : 'a number'}: is the madAuth server newer than this function?`);
    return { statusCode: 400 };
  }
  try {
    await options.sns.send(
      new PublishCommand({
        PhoneNumber: to,
        Message: smsText(String(data.site ?? ''), code, data.purpose),
        MessageAttributes: {
          // A one-time code must arrive now, not be held back by a spending cap on promotional messages.
          'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' },
          ...(options.smsSenderId ? { 'AWS.SNS.SMS.SenderID': { DataType: 'String', StringValue: options.smsSenderId } } : {}),
        },
      }),
    );
  } catch (e) {
    // Not 2xx: madAuth then tells the user that the SMS can't be sent right now.
    console.error(`SNS did not accept the SMS to ${to}:`, e);
    return { statusCode: 502 };
  }
  return { statusCode: 200 };
}

/** Who may call, from MADAUTH_ROLE_ARN or WEBHOOK_SECRET. Both at once is refused: the secret would only be in the way. */
export function callerFromEnv(env: Record<string, string | undefined>): Caller | { problem: string } {
  const roleArn = env.MADAUTH_ROLE_ARN?.trim();
  const secret = env.WEBHOOK_SECRET?.trim();
  if (roleArn && secret) {
    return { problem: 'Both MADAUTH_ROLE_ARN and WEBHOOK_SECRET are set: with MADAUTH_ROLE_ARN, AWS checks the caller and no secret is used. Remove WEBHOOK_SECRET.' };
  }
  return roleArn ? { madauthRoleArn: roleArn } : { secret: secret ?? '' };
}

const caller = callerFromEnv(process.env);

export const handler =
  'problem' in caller
    ? async (): Promise<LambdaFunctionURLResult> => {
        console.error(caller.problem);
        return { statusCode: 500 };
      }
    : createMailer({
        ...caller,
        from: process.env.MAIL_FROM ?? '',
        configurationSet: process.env.SES_CONFIGURATION_SET || undefined,
        ses: new SESv2Client({}),
        sns: process.env.SEND_SMS === 'true' ? new SNSClient({}) : undefined,
        smsSenderId: process.env.SMS_SENDER_ID || undefined,
      });
