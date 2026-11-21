import { ZodError } from "zod";

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

export const errorHandler = (log) => (err, req, res, _next) => {
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
    if (err.headers) res.set(err.headers); // e.g. the WWW-Authenticate challenge
    return res.status(err.status).json({ error: { code: err.code || "ERROR", message: err.message } });
  }
  log.error(err);
  res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong" } });
};
