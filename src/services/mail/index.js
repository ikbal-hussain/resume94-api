import { consoleProvider } from "./providers/console.js";
import { resendProvider } from "./providers/resend.js";

// Add a transport by dropping a { name, envKey, send(message, { apiKey }, fetchImpl, log) }
// module in ./providers and registering it here — routes never learn which one is active.
// An SMTP transport (nodemailer) slots in the same way if a mail host is preferred.
const PROVIDERS = { console: consoleProvider, resend: resendProvider };

export function createMailService(config, fetchImpl = fetch, log = console) {
  const provider = PROVIDERS[config.MAIL_PROVIDER];
  if (!provider) throw new Error(`Unknown MAIL_PROVIDER "${config.MAIL_PROVIDER}"`);
  const apiKey = provider.envKey ? config[provider.envKey] : null;

  return {
    provider: provider.name,
    configured: !provider.envKey || Boolean(apiKey),

    /**
     * Sends a message. Callers that must not reveal whether an address exists
     * should let failures surface here and swallow them, not skip the call.
     */
    async send(message) {
      if (provider.envKey && !apiKey) {
        throw new Error(`MAIL_PROVIDER is "${provider.name}" but ${provider.envKey} is not set`);
      }
      return provider.send({ from: config.MAIL_FROM, ...message }, { apiKey }, fetchImpl, log);
    },
  };
}
