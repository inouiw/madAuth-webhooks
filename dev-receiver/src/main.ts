// Development receiver for madAuth's webhooks: prints the e-mails (with their links and codes) instead of
// sending them. Reads WEBHOOK_URL, WEBHOOK_KEYS_URL and WEBHOOK_SECRET from the environment or from .env, and listens
// on WEBHOOK_URL's port.
import { createServer } from 'node:http';
import { WEBHOOK_KEYS_PATH, webhookKeys } from '@madauth/server/webhook';
import { createReceiver } from './receiver.js';

/** Where a madAuth server on this machine, on its default port, publishes the public keys of its v1a signatures. */
const DEFAULT_KEYS_URL = `http://localhost:8787${WEBHOOK_KEYS_PATH}`;

const url = process.env.WEBHOOK_URL;
// Set but empty: no v1a, only WEBHOOK_SECRET (v1).
const keysUrl = process.env.WEBHOOK_KEYS_URL ?? DEFAULT_KEYS_URL;
const secret = process.env.WEBHOOK_SECRET || undefined;
if (!url) {
  console.error(
    'Set WEBHOOK_URL (e.g. http://localhost:8790/webhook) to the value your madAuth server uses:\n' +
      'copy .env.example to .env and fill it in, or pass it in the environment.',
  );
  process.exit(1);
}
if (!keysUrl && !secret) {
  console.error(
    'WEBHOOK_KEYS_URL is empty and WEBHOOK_SECRET is not set: nothing to check the calls with. Remove WEBHOOK_KEYS_URL to use ' +
      `${DEFAULT_KEYS_URL}, set it to <your madAuth server>/.well-known/webhook-keys.json, or set WEBHOOK_SECRET.`,
  );
  process.exit(1);
}

// verifyWebhook rejects a malformed secret silently, which would look like a wrong signature on every call.
if (secret && !secret.startsWith('whsec_')) {
  console.error('WEBHOOK_SECRET must start with "whsec_". Copy it exactly as your madAuth server has it.');
  process.exit(1);
}

let parsed: URL;
try {
  parsed = new URL(url);
} catch {
  console.error(`WEBHOOK_URL is not a URL: ${url}. Use e.g. http://localhost:8790/webhook.`);
  process.exit(1);
}
if (parsed.protocol !== 'http:') {
  console.error(`WEBHOOK_URL must start with http:// for this receiver: ${url}`);
  process.exit(1);
}
// webhookKeys refuses a URL that is neither https nor on this machine, and says so.
const keys = keysUrl ? webhookKeys(keysUrl) : undefined;
const port = Number(parsed.port || 80);
const allowedDomains = process.env.ALLOWED_EMAIL_DOMAINS?.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
const server = createServer(createReceiver({ keys, secret, allowedDomains }));
server.on('error', (e) => {
  console.error(`Could not listen on port ${port}: ${e.message}`);
  process.exit(1);
});
const checks = [keys && `v1a with the keys from ${keysUrl}`, secret && 'v1 with WEBHOOK_SECRET'].filter(Boolean).join(' and ');
server.listen(port, () => console.log(`madAuth webhook receiver listening on ${url}, checking ${checks}; e-mails appear here.`));
