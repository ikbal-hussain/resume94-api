// Development transport: writes the message to the server log instead of sending it.
// Password-reset links are usable from the log, so local work needs no mail account.
export const consoleProvider = {
  name: "console",
  envKey: null,
  async send({ to, subject, text }, _options, _fetchImpl, log = console) {
    log.info(`\n[mail:console] to: ${to}\n[mail:console] subject: ${subject}\n${text}\n`);
    return { id: "console" };
  },
};
