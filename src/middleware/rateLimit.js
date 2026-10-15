import { HttpError } from "./errors.js";

/**
 * Turns a limiter's store failure into a 503 instead of a 500.
 *
 * A limiter configured with `passOnStoreError: false` forwards the failure to `next`,
 * where the central handler would report it as `INTERNAL` — telling the client the
 * request was broken when the truth is that it was refused, briefly, on purpose. The
 * distinction is worth the wrapper: a frontend can retry a 503 and should not retry a
 * 500.
 *
 * Everything the limiter does arrives through `next`: no argument to carry on, an
 * argument for a store or key-generator failure, and neither when it answers 429 from
 * inside. A wrapper that ignores the argument therefore turns a fail-closed limiter
 * back into a fail-open one without changing a single option — which is how the first
 * draft of this file quietly let unmetered AI calls through.
 *
 * Only the limiters that fail closed need this. One that passes on a store error never
 * reaches `next` with one.
 */
export const failClosed = (limiter, message, log = console) => (req, res, next) =>
  limiter(req, res, (err) => {
    if (!err) return next();
    log.error?.(err);
    const unavailable = new HttpError(503, message, "RATE_LIMIT_UNAVAILABLE");
    // The OpenAPI text invites a retry, so say when rather than leaving the client to
    // guess and hammer. Short, because a counter outage is usually brief.
    unavailable.headers = { "Retry-After": "5" };
    next(unavailable);
  });
