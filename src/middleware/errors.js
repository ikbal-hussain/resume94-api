import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Turns a failed AI provider response into an actionable error. The upstream body is
// logged server-side; the client gets a message that says what an operator must fix
// (a wrong model id or a rejected key is a config problem, not a user mistake).
export async function upstreamFailure(provider, model, res) {
  const body = await res.text().catch(() => "");
  console.error(`[ai:${provider}] ${res.status} for model "${model}": ${body.slice(0, 300)}`);

  if (res.status === 401 || res.status === 403)
    return new HttpError(502, `The ${provider} API key was rejected`, "AI_AUTH");
  if (res.status === 404)
    return new HttpError(502, `The ${provider} model "${model}" is unavailable for this API key`, "AI_MODEL_NOT_FOUND");
  if (res.status === 429)
    return new HttpError(429, `The ${provider} rate limit was reached — try again shortly`, "AI_RATE_LIMITED");
  return new HttpError(502, `The ${provider} request failed`, "AI_UPSTREAM");
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
    return res.status(err.status).json({ error: { code: err.code || "ERROR", message: err.message } });
  }
  log.error(err);
  res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong" } });
};
