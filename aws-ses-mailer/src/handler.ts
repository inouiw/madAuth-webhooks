// A madAuth webhook receiver on AWS Lambda (Function URL): sends madAuth's e-mails with Amazon SES and its
// SMS codes with Amazon SNS. It answers 200 only after SES or SNS has accepted a message, so madAuth knows
// whether it went out.
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { verifyWebhook } from '@madauth/server/webhook';
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { alreadyRegisteredMail, noPasswordMail, resetPasswordMail, signInMail, smsText, type Mail, verifyEmailMail } from './templates.js';

export interface MailerOptions {
  /** The same WEBHOOK_SECRET madAuth uses. */
  secret: string;
  /** Sender, e.g. `"Example" <no-reply@example.com>`; its domain must be verified in SES. */
  from: string;
  /** Optional SES configuration set, e.g. to record bounces and complaints. */
  configurationSet?: string;
  ses: Pick<SESv2Client, 'send'>;
  /** Sends the SMS codes (`sms.code`). Without it, an SMS is answered with an error, so madAuth reports it. */
  sns?: Pick<SNSClient, 'send'>;
  /** Optional sender name shown instead of a number, where carriers support it (SNS `AWS.SNS.SMS.SenderID`). */
  smsSenderId?: string;
}

interface Call {
  type: string;
  data: Record<string, any>;
}

/** How the user signs in, from the call's `methods` (e.g. `["google"]`); empty when the call has none. */
const methodsOf = (data: Record<string, any>): string[] => (Array.isArray(data.methods) ? data.methods.map(String) : []);

/** The calls of the `email.*` and `sms.*` families that are events, not messages to send: an empty 2xx is the right answer. */
const EVENTS = ['email.verified', 'email.password_reset', 'sms.enabled', 'sms.disabled'];

/** The e-mail for a webhook call, or null if the call is not an e-mail. */
function mailFor({ type, data }: Call): Mail | null {
  switch (type) {
    case 'email.verify':
      return verifyEmailMail(data.to, data.site, data.link, data.code);
    case 'email.reset':
      return resetPasswordMail(data.to, data.site, data.link, data.code);
    case 'email.signin':
      return signInMail(data.to, data.site, data.link, data.code);
    case 'email.already_registered':
      return alreadyRegisteredMail(data.to, data.site, data.link, methodsOf(data));
    case 'email.no_password':
      return noPasswordMail(data.to, data.site, data.link, methodsOf(data));
    default:
      return null;
  }
}

export function createMailer(options: MailerOptions) {
  return async (event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> => {
    // Verify the raw body exactly as it arrived: re-serialized JSON would not match the signature.
    const body = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
    if (!verifyWebhook(options.secret, event.headers, body)) {
      console.warn('Rejected a call with a wrong signature. Do madAuth and this function use the same WEBHOOK_SECRET?');
      return { statusCode: 401 };
    }
    let call: Call | null;
    try {
      call = JSON.parse(body) as Call | null;
    } catch {
      return { statusCode: 400 };
    }
    if (!call || typeof call.type !== 'string' || !call.data || typeof call.data !== 'object') return { statusCode: 400 };

    if (call.type === 'sms.code') return sendSms(options, call.data);

    const mail = mailFor(call);
    if (!mail) {
      // An e-mail or SMS this version doesn't know: not 2xx, so madAuth doesn't count it as sent but tells the
      // user that it can't be sent right now, and the server's log says what to update.
      if ((call.type.startsWith('email.') || call.type.startsWith('sms.')) && !EVENTS.includes(call.type)) {
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
    console.error('An SMS code arrived, but SMS sending is not set up: deploy with SendSms=true, or take sms.code out of the madAuth server\'s WEBHOOK_EVENTS.');
    return { statusCode: 400 };
  }
  const to = String(data.to ?? '');
  try {
    await options.sns.send(
      new PublishCommand({
        PhoneNumber: to,
        Message: smsText(String(data.site ?? ''), String(data.code ?? ''), data.purpose),
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

export const handler = createMailer({
  secret: process.env.WEBHOOK_SECRET ?? '',
  from: process.env.MAIL_FROM ?? '',
  configurationSet: process.env.SES_CONFIGURATION_SET || undefined,
  ses: new SESv2Client({}),
  sns: process.env.SEND_SMS === 'true' ? new SNSClient({}) : undefined,
  smsSenderId: process.env.SMS_SENDER_ID || undefined,
});
