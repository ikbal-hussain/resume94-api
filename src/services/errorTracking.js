// Error tracking (Sentry). Off unless SENTRY_DSN is set, so local work and the tests
// need nothing and a deployment without a DSN never even loads the SDK.
//
// Resumes are personal data, so the SDK is configured to collect as little as it can and
// `scrubEvent` removes anything that still slips through. Three layers, on purpose:
//   1. Only the integrations listed below run. The defaults also wrap console, http and
//      fetch (breadcrumbs carrying provider bodies and Upstash URLs whose keys hold client
//      IPs), attach the incoming request, and record local variables (a resume in scope).
//   2. `dataCollection` turns every automatic category off, in case an integration added
//      later reads it. (It replaced `sendDefaultPii`, which @sentry/node 11 no longer has.)
//   3. `beforeSend` strips request bodies, cookies, headers, query strings, user fields
//      other than an id, frame variables, breadcrumb data, and email addresses in text.

// Long enough for one event to reach Sentry from iad1, short enough that a 500 is not
// noticeably slower. The function freezes once the response is sent, so the flush has to
// finish first or the event is lost.
export const FLUSH_TIMEOUT_MS = 2000;

// 5xx states the API produces by design rather than by failure. Each would otherwise be
// one event per AI request until it cleared (the daily budget, a missing provider key),
// spending the free plan's monthly quota on something /api/health already reports.
const EXPECTED_CODES = new Set(["AI_BUDGET_EXHAUSTED", "AI_UNAVAILABLE", "GOOGLE_NOT_CONFIGURED"]);

/** Whether an error answered with `status` belongs in error tracking. */
export function shouldCapture(err, status) {
  return status >= 500 && !EXPECTED_CODES.has(err?.code);
}

const disabled = Object.freeze({
  configured: false,
  async capture() {},
  async flush() {},
});

/**
 * `load` is injectable so a test can hand in a fake SDK and inspect what init receives,
 * without a network or a real DSN.
 */
export function createErrorTracker(config, { log = console, load = () => import("@sentry/node") } = {}) {
  const dsn = config.SENTRY_DSN?.trim();
  if (!dsn) return disabled;

  const ready = load()
    .then((Sentry) => {
      // api/index.js rebuilds the app after a failed start; one client per process.
      if (!Sentry.getClient()) Sentry.init(sentryOptions(config, dsn, Sentry));
      return Sentry;
    })
    .catch((err) => {
      log.error("[errors] Sentry failed to load; error tracking is off", err);
      return null;
    });

  return {
    configured: true,
    // Never throws and never takes much longer than FLUSH_TIMEOUT_MS: it runs on the way
    // to a 500, and a broken tracker must not turn that into a hung request.
    async capture(err, { method, route } = {}) {
      try {
        const Sentry = await ready;
        if (!Sentry) return;
        Sentry.captureException(err, { tags: { method, route } });
        await Sentry.flush(FLUSH_TIMEOUT_MS);
      } catch (trackingErr) {
        log.error("[errors] could not report an error", trackingErr);
      }
    },
    async flush() {
      try {
        const Sentry = await ready;
        await Sentry?.flush(FLUSH_TIMEOUT_MS);
      } catch {
        // Nothing useful to do; the original error has already been logged.
      }
    },
  };
}

function sentryOptions(config, dsn, Sentry) {
  return {
    dsn,
    // Vercel's own names: production, preview, development. NODE_ENV off Vercel.
    environment: config.VERCEL_ENV ?? config.NODE_ENV,
    release: config.VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: 0,
    defaultIntegrations: false,
    integrations: [
      Sentry.eventFiltersIntegration(),
      Sentry.functionToStringIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.dedupeIntegration(),
      Sentry.onUncaughtExceptionIntegration(),
      Sentry.onUnhandledRejectionIntegration(),
      Sentry.contextLinesIntegration(),
      Sentry.nodeContextIntegration(),
    ],
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    beforeSend: scrubEvent,
  };
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const redactEmails = (text) => (typeof text === "string" ? text.replace(EMAIL, "[email]") : text);
// Enough to tell a browser from a script; nothing that identifies or authenticates.
const KEPT_HEADERS = new Set(["content-type", "content-length", "user-agent"]);

/**
 * Removes personal data from an event before it leaves the process. Exported for the
 * tests; it is the `beforeSend` hook. Mutates and returns the event.
 *
 * Emails are matched in free text because Mongo puts the duplicate key into the message
 * (`E11000 ... { email: "..." }`), and that is exactly the kind of error that gets here.
 */
export function scrubEvent(event) {
  if (event.request) {
    const { method, url, headers } = event.request;
    event.request = { method, url: typeof url === "string" ? url.split("?")[0] : undefined };
    if (headers) {
      event.request.headers = Object.fromEntries(
        Object.entries(headers).filter(([name]) => KEPT_HEADERS.has(name.toLowerCase()))
      );
    }
  }
  if (event.user) event.user = event.user.id === undefined ? undefined : { id: event.user.id };
  event.message = redactEmails(event.message);
  if (event.logentry) event.logentry.message = redactEmails(event.logentry.message);
  for (const exception of event.exception?.values ?? []) {
    exception.value = redactEmails(exception.value);
    for (const frame of exception.stacktrace?.frames ?? []) delete frame.vars;
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map(({ data: _data, ...crumb }) => ({ ...crumb, message: redactEmails(crumb.message) }));
  }
  if (event.extra) delete event.extra;
  return event;
}
