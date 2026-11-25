import { ZodError } from "zod";
import { shouldCapture } from "../services/errorTracking.js";

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// A provider 429 that names a daily limit: Groq says "tokens per day (TPD)" or
// "requests per day (RPD)", Gemini names quotas like "...PerDayPerProjectPerModel".
const DAILY_LIMIT = /per[\s_-]?day|\b[TR]PD\b/i;

// Turns a failed AI provider response into an actionable error. The upstream body is
// logged server-side; the client gets a message that says what an operator must fix
// (a wrong model id or a rejected key is a config problem, not a user mistake).
//
// Every error from here is marked `refundable`: the provider answered with an HTTP error,
// so no reply was produced and the user should not pay for it.
export async function upstreamFailure(provider, model, res) {
  const body = await res.text().catch(() => "");
  console.error(`[ai:${provider}] ${res.status} for model "${model}": ${body.slice(0, 300)}`);

  const err = (() => {
    if (res.status === 401 || res.status === 403)
      return new HttpError(502, `The ${provider} API key was rejected`, "AI_AUTH");
    if (res.status === 404)
      return new HttpError(502, `The ${provider} model "${model}" is unavailable for this API key`, "AI_MODEL_NOT_FOUND");
    if (res.status === 429) return rateLimited(body, res.headers?.get?.("retry-after"));
    return new HttpError(502, `The ${provider} request failed`, "AI_UPSTREAM");
  })();
  err.refundable = true;
  return err;
}

// The provider's own limit, in words a user can act on; its wording never reaches them.
// A daily limit is the same situation as the app's own budget running out, so it gets
// the same code and message, and `dailyLimit` tells the route to close the budget for
// the rest of the day. Anything else is per-minute: busy, try again shortly.
function rateLimited(body, retryAfter) {
  if (DAILY_LIMIT.test(body)) {
    const err = new HttpError(503, "AI has reached today’s capacity and is resting until tomorrow — everything else still works", "AI_BUDGET_EXHAUSTED");
    err.dailyLimit = true;
    return err;
  }
  const err = new HttpError(429, "AI is busy right now. Please try again in a minute.", "AI_RATE_LIMITED");
  if (retryAfter) err.headers = { "Retry-After": retryAfter };
  return err;
}

// Parses req.body through a zod schema, replacing it with the cleaned value.
export const validateBody = (schema) => (req, _res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) return next(result.error);
  req.body = result.data;
  next();
};

export const notFound = (_req, _res, next) => next(new HttpError(404, "Route not found", "NOT_FOUND"));

// `errors` is the tracker from services/errorTracking.js. Only 5xx reach it: a 4xx is the
// client's mistake and expected, a 5xx is ours. It is awaited before the response because
// the serverless function freezes once the response is sent, taking an unsent event with
// it; the tracker bounds that wait to two seconds and never throws.
export const errorHandler = (log, errors) => async (err, req, res, next) => {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid request",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
    });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body too large" } });
  }
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: { code: "BAD_JSON", message: "Malformed JSON" } });
  }
  if (err instanceof HttpError) {
    if (shouldCapture(err, err.status)) await errors?.capture(err, where(req));
    // The wait above can outlast a response something else already started; Express's
    // own handler then closes the connection rather than writing a second one.
    if (res.headersSent) return next(err);
    if (err.headers) res.set(err.headers); // e.g. the WWW-Authenticate challenge
    return res.status(err.status).json({ error: { code: err.code || "ERROR", message: err.message } });
  }
  log.error(err);
  if (!clientFault(err)) await errors?.capture(err, where(req));
  if (res.headersSent) return next(err);
  res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong" } });
};

// body-parser's own errors (a client hanging up mid-upload is "request.aborted", 400)
// still answer 500 here, as before, but they are the client's doing. Their 4xx is trusted
// only because body-parser marks them: `type`, or http-errors' `expose`. Any other error
// that happens to carry a status — a provider SDK's 401 for a rejected key — is ours.
function clientFault(err) {
  const status = err.status ?? err.statusCode;
  return status >= 400 && status < 500 && (typeof err.type === "string" || err.expose === true);
}

/**
 * Records where a router is mounted. Express resets req.baseUrl before an app-level
 * error handler runs, so without this req.route.path reads "/:token" with its mount gone.
 */
export const rememberMount = (req, _res, next) => {
  req.mountPath = req.baseUrl;
  next();
};

// The matched route pattern, never the URL: "/api/auth/reset-password/:token" groups
// every failure into one issue and carries neither the token nor an id nor a query
// string. A request no route matched gets no path at all, since its URL is arbitrary.
function where(req) {
  const route = req.route ? `${req.mountPath ?? ""}${req.route.path}` : "(unmatched)";
  return { method: req.method, route };
}
