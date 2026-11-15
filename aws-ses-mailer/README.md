# Sending madAuth's e-mails with Amazon SES (and its SMS with Amazon SNS)

A madAuth [webhook](https://github.com/inouiw/madAuth/blob/main/docs/server.md#webhooks) receiver on AWS Lambda that sends the confirmation, password-reset and sign-in e-mails with [Amazon SES](https://aws.amazon.com/ses/), and, if you turn it on, the SMS codes with [Amazon SNS](https://aws.amazon.com/sns/). It:

- checks that each call is signed with madAuth's webhook key (`v1a`), with the public keys madAuth publishes, so it holds no secret; or with your `WEBHOOK_SECRET` (`v1`), for a server without a webhook key; or, when the madAuth server runs on AWS too, that it comes from the server's role (see [AWS IAM instead of the secret](#aws-iam-instead-of-the-secret))
- renders the e-mail or the SMS ([`src/templates.ts`](src/templates.ts)) with the link and the 6-digit code
- answers `200` only after SES or SNS has accepted the message. Otherwise it answers `502`, and madAuth tells the user that it can't be sent right now.

Other calls (the sign-up check and events) are answered with `204`, which allows sign-ups. madAuth only sends them if you add their types to `WEBHOOK_EVENTS`; add your own logic to [`src/handler.ts`](src/handler.ts) if you need it.

Costs: SES charges about $0.10 per 1000 e-mails; SNS charges per SMS, from about $0.005 in the US to several cents elsewhere. The Lambda function stays in the free tier for most sites.

## What you need

- An AWS account and the [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html), signed in (`aws configure` or `aws sso login`).
- A domain you can add DNS records to, e.g. `example.com`. The e-mails come from an address at it, e.g. `no-reply@example.com`.

## 1. Verify your domain in SES

Pick one AWS region for SES and the function, e.g. `eu-central-1`, and use it everywhere below.

1. Open the [SES console](https://console.aws.amazon.com/ses/) → **Identities** → **Create identity** → **Domain**, and enter your domain.
2. Keep **Easy DKIM** (RSA 2048) selected and create the identity. SES shows three CNAME records: add them at your DNS provider. After a few minutes to hours, the identity shows **Verified**.
3. Recommended: under **Custom MAIL FROM domain**, set e.g. `mail.example.com` and add the MX and TXT records SES shows. Then SPF passes with your own domain.
4. Recommended: add a DMARC record if your domain has none, e.g. a TXT record at `_dmarc.example.com` with `v=DMARC1; p=none; rua=mailto:dmarc@example.com`. Mail providers such as Gmail expect one.

## 2. Leave the SES sandbox

New SES accounts are in a sandbox: they can only send to addresses you verified yourself, and at most 200 e-mails a day. That's enough for a first test (verify your own address under **Identities** → **Create identity** → **Email address**). Before real users sign up, open **Account dashboard** → **Request production access** and describe the use: "transactional e-mails (address confirmation and password reset) for sign-ups on our site". AWS usually answers within a day.

## 3. Note where madAuth publishes its webhook keys

madAuth 0.7.5 and newer sign every call with an Ed25519 key of their key service (`v1a`; `init` and madAuth's AWS template set one up) and publish its public keys at `<MADAUTH_ISSUER>/.well-known/webhook-keys.json`, e.g. `https://example.com/.well-known/webhook-keys.json`. This function fetches them from there (it needs to reach that URL: the default Lambda networking does, a VPC needs a way out) and checks each call with them. Nothing secret is shared: whoever reads this function's configuration can't make it send e-mails. Check that the list has a key:

```bash
curl https://example.com/.well-known/webhook-keys.json
```

A madAuth server without a webhook key (`{"keys":[]}`, e.g. from before 0.7.5) signs with its `WEBHOOK_SECRET` alone: give this function the same secret (`WebhookSecret`), or add the key and move as in [Moving from the secret to the webhook key](#moving-from-the-secret-to-the-webhook-key). When the madAuth server runs on AWS with `WEBHOOK_AUTH=aws-iam`, neither is used: see [AWS IAM instead of the secret](#aws-iam-instead-of-the-secret).

## 4. Deploy

Get this repository and install the function's dependencies:

```bash
git clone https://github.com/inouiw/madAuth-webhooks.git
```

```bash
cd madAuth-webhooks/aws-ses-mailer && npm install
```

Then build and deploy:

```bash
sam build
```

```bash
sam deploy --guided
```

The guided deploy asks for:

| Parameter | Example |
| --- | --- |
| Stack name | `madauth-mailer` |
| AWS region | the SES region from step 1 |
| `WebhookKeysUrl` | the URL from step 3, e.g. `https://example.com/.well-known/webhook-keys.json` |
| `WebhookSecret` | leave empty, or the madAuth server's `WEBHOOK_SECRET` for one that signs with it (step 3) |
| `MadauthRoleArn` | leave empty, or see [AWS IAM instead of the secret](#aws-iam-instead-of-the-secret) |
| `MailFrom` | `"Example" <no-reply@example.com>` |
| `SendingDomain` | `example.com` (the identity from step 1) |
| `ConfigurationSet` | leave empty, or see "Bounces and complaints" below |
| `SendSms` | `false`, or `true` to send madAuth's SMS codes: see "SMS codes" below |
| `SmsSenderId` | leave empty, or a sender name of 3 to 11 letters and digits, where carriers show one |

The function's URL is public: the function checks every call's signature itself. It fetches madAuth's keys at its first call and keeps them for ten minutes, and again (at most every 30 seconds) when a call's signature matches none of them, as after madAuth's key rotation. At the end, SAM prints the output **WebhookUrl**, e.g. `https://abc123.lambda-url.eu-central-1.on.aws/`.

If `sam build` fails with `Unknown cli flag: --unsafe-perm`, your SAM CLI is older than your npm. Update the SAM CLI.

## 5. Connect madAuth

Set these on the madAuth server and restart it:

```
WEBHOOK_URL=https://abc123.lambda-url.eu-central-1.on.aws/
WEBHOOK_EVENTS=email.send_verification,email.send_password_reset,email.send_signin_link,email.send_already_registered,email.send_password_reset_no_password
```

With `WebhookSecret`, the server keeps its `WEBHOOK_SECRET`; with madAuth's AWS template, set `webhookUrl` and `webhookEvents` in its `cdk.json`.

`WEBHOOK_EVENTS` lists what this function handles: the five e-mails (`email.send_signin_link` is the passwordless e-mail link of madAuth 0.5; leave it out to keep that method off). With `SendSms=true`, add `sms.send_code` for the SMS codes. madAuth then sends nothing else to it. An e-mail or SMS type this function doesn't know (from a newer madAuth) is answered with an error, so madAuth doesn't count it as sent: update the function, or take the type out of the list.

**Upgrading madAuth to 0.5:** these are its names. A server from before sends `email.verify`, `email.reset`, `email.signin`, `email.already_registered`, `email.no_password` and `sms.code`, and this function sends those as well. So deploy this version first, then upgrade the server and rename its `WEBHOOK_EVENTS` (a 0.5 server with an old name in it refuses to start and says the new one).

## 6. Test

Sign up in your app with an address you can read (in the sandbox, a verified one). The confirmation e-mail should arrive within seconds.

If it doesn't, check these in order:
- **The madAuth server's log:** `[madauth] Webhook "email.send_verification" … failed: HTTP 401` means the signature didn't match: `WebhookKeysUrl` isn't this server's key list or it lists no key, or the two secrets differ; the function's log says which it checked (with AWS IAM, see [below](#aws-iam-instead-of-the-secret)). `HTTP 502` means SES refused the e-mail.
- **`Could not fetch the webhook keys`** in the function's log: it can't reach `WebhookKeysUrl`.
- **The function's log** in CloudWatch (Lambda console → the function → **Monitor** → **View CloudWatch logs**), which contains SES's reason, e.g. `MessageRejected: Email address is not verified` while in the sandbox.
- **`AccessDenied` for a resource `identity/<the recipient's address>`** in the function's log: in the sandbox, SES also checks the policy against the recipient's verified identity, and the function may only use your sending domain. It goes away with production access (step 2).
- **Your spam folder.** If the e-mail lands there, check that DKIM and DMARC are set up (step 1).

## Moving from the secret to the webhook key

For a function deployed with `WebhookSecret` (`v1`), to one that checks madAuth's webhook key (`v1a`) and holds no secret, without a gap (see [Moving a receiver to v1a](https://github.com/inouiw/madAuth/blob/main/docs/server.md#moving-a-receiver-to-v1a) in the madAuth docs):

1. Give the madAuth server (0.7.5 or newer) a webhook key, e.g. deploy madAuth's AWS template, which creates it. Every call now carries both signatures.
2. Deploy this function with `WebhookKeysUrl` next to `WebhookSecret`: it accepts either signature.
3. Remove `WEBHOOK_SECRET` from the madAuth server (with the template, delete `<secretsPath>/WEBHOOK_SECRET`, see [Moving the receiver to v1a](https://github.com/inouiw/madAuth/blob/main/deploy/aws/README.md#moving-the-receiver-to-v1a)).
4. Deploy this function again with an empty `WebhookSecret`.

## AWS IAM instead of the secret

When the madAuth server runs on AWS too, in the same account (e.g. with [madAuth's AWS template](https://github.com/inouiw/madAuth/tree/main/deploy/aws)), IAM can replace the shared secret: madAuth signs every call with its role (`WEBHOOK_AUTH=aws-iam`), and this function's URL has `AWS_IAM` auth, so AWS refuses calls that aren't signed by a principal allowed to invoke it before the function runs. The function then accepts only calls of madAuth's role, whose ARN it gets as `MADAUTH_ROLE_ARN`; others of the account who may invoke it, e.g. admins, are refused with `403`. Nobody has a secret that could make it send e-mails or SMS as if madAuth called. It needs a madAuth server newer than 0.6.0-beta.2.

1. Get the ARN of the madAuth server's role: with the AWS template, its output `RoleArn`, e.g. `arn:aws:iam::123456789012:role/MadAuth-MadAuthFunctionServiceRole-AbC123`.
2. Deploy this function with that ARN as `MadauthRoleArn` and an empty `WebhookKeysUrl` and `WebhookSecret` (`sam deploy --guided`, or `sam deploy --parameter-overrides MadauthRoleArn=<the ARN> WebhookKeysUrl='' WebhookSecret=''`). The template refuses the role with either. Note the outputs **WebhookUrl** and **FunctionArn**.
3. Let madAuth's role invoke the URL, and set madAuth's `WEBHOOK_URL` to it, `WEBHOOK_AUTH=aws-iam`, and no `WEBHOOK_SECRET`. With madAuth's AWS template, set `webhookUrl` and `webhookFunctionArn` (the output **FunctionArn**) and deploy it. Otherwise the role's policy needs `lambda:InvokeFunctionUrl` (with the condition `lambda:FunctionUrlAuthType` = `AWS_IAM`) and `lambda:InvokeFunction` (with `lambda:InvokedViaFunctionUrl` = `true`) on the function: see [AWS IAM](https://github.com/inouiw/madAuth/blob/main/docs/server.md#aws-iam) in the madAuth docs.

**Moving from the secret:** from the moment one of madAuth and this function has switched until the other has, the calls fail: no e-mail is sent, and users see that it failed. So deploy the two right after each other, in the order of [Switching the webhook receiver to AWS IAM](https://github.com/inouiw/madAuth/blob/main/deploy/aws/README.md#switching-the-webhook-receiver-to-aws-iam).

In madAuth's log, `HTTP 403` means the call was refused: by AWS, when madAuth's role may not invoke the URL or madAuth doesn't sign its calls (`WEBHOOK_AUTH=aws-iam`), or by this function, when `MadauthRoleArn` isn't madAuth's role (its log then says "only madAuth's role"). `HTTP 401` means the URL has no `AWS_IAM` auth, and `HTTP 500` that `MADAUTH_ROLE_ARN` is no role's ARN, or that `WEBHOOK_KEYS_URL` or `WEBHOOK_SECRET` is set as well (this function's log says which). Without the role: `HTTP 500` means none of `WebhookKeysUrl`, `WebhookSecret` and `MadauthRoleArn` is set, or one is malformed, and `HTTP 503` that madAuth's keys couldn't be fetched from `WebhookKeysUrl`.

## SMS codes

madAuth 0.5 can ask for a code sent to the user's phone as a second factor (`sms.send_code` in the madAuth docs). With `SendSms=true`, this function sends those codes with Amazon SNS as transactional SMS, and the SAM template gives it `sns:Publish`. Before that works:

1. **Leave the SMS sandbox.** New accounts can only send to phone numbers you verified in the [SNS console](https://console.aws.amazon.com/sns/) → **Text messaging (SMS)** → **Sandbox destination phone numbers**; that is enough for a test with your own phone. For real users, request production access on that page.
2. **Raise the spending limit.** SNS stops sending at $1.00 per month by default. Set a higher **Account spend limit** under **Text messaging (SMS)** → **Text messaging preferences** (an AWS support request).
3. **Check your countries.** Some countries require a registered sender (e.g. a 10DLC or toll-free number in the US, a registered sender ID in India): see [SNS SMS country support](https://docs.aws.amazon.com/sns/latest/dg/sns-supported-regions-countries.html). Where an alphabetic sender ID is shown, `SmsSenderId` sets it.
4. Deploy again with `sam deploy` and the two parameters, and add `sms.send_code` to the madAuth server's `WEBHOOK_EVENTS`.

Without `SendSms=true`, an SMS code is answered with an error, so madAuth tells the user that the SMS can't be sent, and the function's log says why. The SMS text is `smsText` in [`src/templates.ts`](src/templates.ts): one segment, with the code and what it is for.

## Bounces and complaints

SES suspends accounts whose e-mails bounce or are marked as spam too often. Watch the rates under **Account dashboard** → **Reputation metrics**. To record each bounce and complaint, create a **configuration set** with an event destination (e.g. an SNS topic that e-mails you), and deploy again with its name as `ConfigurationSet`.

## Changing the e-mails

Edit [`src/templates.ts`](src/templates.ts) and deploy again (`sam build && sam deploy`). Each call contains the user's browser language as `data.locale` (e.g. `de-CH`), if you want to send translated e-mails or SMS.
