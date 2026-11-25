// The Vercel request handler around createApp, kept apart from api/index.js so the tests
// can drive a failing start without a real database or a real SDK.

// How often one instance reports a failed start. During an Atlas outage every request
// fails the same way; reporting each would send one event per request and make every
// one of them wait for a flush, when the first event already says everything.
export const INIT_REPORT_INTERVAL_MS = 60_000;

/**
 * `init(track)` builds the app; it calls `track(errors)` with its error tracker as soon as
 * it has one, so a failure later in the start (the database) can still be reported.
 */
export function createHandler(init, { log = console, now = Date.now, reportEveryMs = INIT_REPORT_INTERVAL_MS } = {}) {
  let appPromise;
  let errors;
  let lastReport = -Infinity;
  const track = (tracker) => {
    errors ??= tracker;
  };

  return async function handler(req, res) {
    try {
      appPromise ??= init(track);
      const app = await appPromise;
      return app(req, res);
    } catch (err) {
      appPromise = undefined; // retry init on the next request
      log.error("init failed", err);
      // Repeats within the interval are not sent at all, so they do not wait either.
      if (errors && now() - lastReport >= reportEveryMs) {
        lastReport = now();
        await errors.capture(err, { method: req.method, route: "(init)" });
      }
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: { code: "INIT_FAILED", message: "Service unavailable" } }));
    }
  };
}
