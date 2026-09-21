import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
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
