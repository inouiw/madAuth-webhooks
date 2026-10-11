# Development receiver

Receives madAuth's [webhook](https://github.com/inouiw/madAuth/blob/main/docs/server.md#webhooks) calls on your machine and prints them instead of sending e-mails or SMS: each confirmation, reset and sign-in e-mail appears in the terminal with its link and its 6-digit code, and each SMS code with its number.

```
[webhook] E-mail to ada@example.com: Confirm your e-mail address (localhost:5173)
  Link: http://localhost:5173/#madauth_verify=H48qfE43P9QS291GUN_RCsmoHgB0V_JuLtHIj0a-q4Q
  Code: 513 416

[webhook] SMS to +41791234567: Sign in (localhost:5173)
  Code: 355 069
```

It uses the real path: the madAuth server signs each call and this receiver verifies the signature, as a receiver in production does.

## Run it

You need Node.js 22.13 or newer.

```bash
git clone https://github.com/inouiw/madAuth-webhooks.git
```

```bash
cd madAuth-webhooks/dev-receiver && npm install
```

Give it the `WEBHOOK_URL` and `WEBHOOK_SECRET` of your madAuth server (they are in the `.env` that `npx @madauth/server init` wrote): copy `.env.example` to `.env` and fill them in. Then start it:

```bash
npm run dev
```

It listens on the port of `WEBHOOK_URL`, by default `http://localhost:8790/webhook`. You can also pass the two values in the environment instead of `.env`:

```bash
WEBHOOK_URL=http://localhost:8790/webhook WEBHOOK_SECRET=whsec_... npm run dev
```

The madAuth server only sends the types listed in its `WEBHOOK_EVENTS`. To see everything here, list them all on the server:

```
WEBHOOK_EVENTS=email.verify,email.reset,email.signin,email.already_registered,email.no_password,signup.before,user.created,email.verified,email.password_reset,user.signed_in,user.deleted,user.claims_changed,totp.enabled,totp.disabled,totp.recovery_code_used,sms.code,sms.enabled,sms.disabled
```

`email.signin` switches the passwordless e-mail link on and `sms.code` SMS codes as a second factor (madAuth 0.5): their links and codes appear here like the others.

## Try the sign-up check

With `signup.before` in the server's `WEBHOOK_EVENTS`, this receiver decides who may sign up, with a password, with Google or with GitHub. Start it with `ALLOWED_EMAIL_DOMAINS` and sign-ups from other domains are refused with a message:

```bash
ALLOWED_EMAIL_DOMAINS=example.com npm run dev
```

## If nothing appears

- **`Rejected a call with a wrong signature`**: the server and the receiver have different `WEBHOOK_SECRET` values.
- **The madAuth server logs `Webhook "email.verify" … failed`** (or `"sms.code"`): the receiver is not running, or `WEBHOOK_URL` on the server points elsewhere.
- **A madAuth server in Docker** reaches a receiver on your machine at `http://host.docker.internal:8790/webhook`.

## The code

[`src/receiver.ts`](src/receiver.ts) is also a small example of a receiver: it verifies the signature with `verifyWebhook` from `@madauth/server/webhook` on the raw body, then answers each `type`. To send real e-mails and SMS, see the [Amazon SES mailer](../aws-ses-mailer).
