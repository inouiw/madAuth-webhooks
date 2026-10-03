# madAuth webhooks

Webhook receivers for [madAuth](https://github.com/inouiw/madAuth), the self-hostable sign-in service.

madAuth sends no e-mails itself. When a user signs up or resets a password, the madAuth server hands the e-mail to a **webhook receiver**: one URL of yours that it calls with a signed request. The same receiver can also decide who may sign up and learn what happened (sign-ins, deleted accounts, role changes). See [Webhooks](https://github.com/inouiw/madAuth/blob/main/docs/server.md#webhooks) in the madAuth docs for every call and its fields.

This repository holds receivers you can run as they are or copy into your own project.

| Receiver | What it does | Use it for |
| --- | --- | --- |
| [`dev-receiver`](dev-receiver) | Prints each e-mail in the terminal, with its link and code. Can refuse sign-ups by e-mail domain. | Development on your machine |
| [`aws-ses-mailer`](aws-ses-mailer) | An AWS Lambda function that sends the e-mails with Amazon SES. Comes with an AWS SAM template and step-by-step setup. | Production on AWS |

Each folder stands alone: it has its own `package.json`, tests and README.

## Start in a minute

With a madAuth server set up by `npx @madauth/server init`:

```bash
git clone https://github.com/inouiw/madAuth-webhooks.git
```

```bash
cd madAuth-webhooks/dev-receiver && npm install
```

```bash
WEBHOOK_URL=http://localhost:8790/webhook WEBHOOK_SECRET=whsec_... npm run dev
```

Use the `WEBHOOK_SECRET` from your server's `.env`. Sign up in your app, and the confirmation e-mail appears in this terminal.

## What every receiver does

A receiver is a small HTTP endpoint. The ones here follow the same rules, and yours should too:

1. **Verify the signature first, on the raw body.** Calls are signed in the [Standard Webhooks](https://www.standardwebhooks.com/) format. In JavaScript, `verifyWebhook` from `@madauth/server/webhook` does it; other languages can use a Standard Webhooks library. Answer `401` to anything else.
2. **Answer 2xx to an e-mail only once it is on its way**, e.g. after your mail service accepted it. madAuth waits for the answer and tells the user if the e-mail could not be sent.
3. **Answer within 10 seconds** (5 seconds for events such as `user.created`). madAuth does not retry.
4. **Answer `204` to types you don't handle.** madAuth only sends the types listed in its `WEBHOOK_EVENTS`, so list what your receiver handles there.

## Contributing a receiver

Receivers for other mail services and platforms are welcome, e.g. SMTP, Resend, Postmark, Azure Communication Services or Cloudflare Workers.

- Put it in a folder of its own, named after what it does, with a README that takes a reader from nothing to a received e-mail.
- Keep it small and easy to copy: one handler, the e-mail texts in one place, few dependencies.
- Add tests for the signature check and for each call type it handles, and add the folder to the matrix in [`.github/workflows/ci.yml`](.github/workflows/ci.yml).
- Follow the four rules above.

Open an issue first if you are unsure whether a receiver fits.

## License

[MIT](LICENSE)
