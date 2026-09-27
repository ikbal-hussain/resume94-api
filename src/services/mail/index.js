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

  // A reset link in a log is a working credential for whoever can read the log, so the
  // console transport is refused in production. Refused here rather than at startup:
  // a mail setting should cost password reset, not take auth, resumes and AI down too.
  const refuseConsole = config.NODE_ENV === "production" && provider.name === "console";
  if (refuseConsole) {
    log.error?.(
      '[mail] MAIL_PROVIDER="console" cannot be used in production — it would write live ' +
        "reset links to the log. Password reset is disabled until a real transport is configured."
    );
  }

  return {
    provider: provider.name,
    configured: !refuseConsole && (!provider.envKey || Boolean(apiKey)),

    /**
     * Sends a message. Callers that must not reveal whether an address exists
     * should let failures surface here and swallow them, not skip the call.
     */
    async send(message) {
      if (refuseConsole) {
        throw new Error('MAIL_PROVIDER="console" is refused in production; set a real transport');
      }
      if (provider.envKey && !apiKey) {
        throw new Error(`MAIL_PROVIDER is "${provider.name}" but ${provider.envKey} is not set`);
      }
      return provider.send({ from: config.MAIL_FROM, ...message }, { apiKey }, fetchImpl, log);
    },
  };
}
