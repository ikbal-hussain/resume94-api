import { timingSafeEqual } from "node:crypto";
import { HttpError } from "./errors.js";

// Compared byte-for-byte in constant time so a wrong password cannot be narrowed
// down by how quickly it is rejected.
const matches = (given, expected) => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Guards the API documentation.
 *
 * Open outside production, because the docs are the point during development.
 * In production they are private: an endpoint list, every field and every limit
 * is free reconnaissance, and a public product has no reason to publish it.
 *
 * With DOCS_USER and DOCS_PASSWORD set, the docs sit behind basic auth — enough
 * to share with a reviewer. Without them the route reports itself missing rather
 * than prompting, so its existence is not advertised either.
 */
export function docsGuard(config) {
  const guarded = config.NODE_ENV === "production";
  const user = config.DOCS_USER;
  const password = config.DOCS_PASSWORD;

  return (req, _res, next) => {
    if (!guarded) return next();
    if (!user || !password) return next(new HttpError(404, "Route not found", "NOT_FOUND"));

    const [scheme, encoded] = (req.headers.authorization || "").split(" ");
    if (scheme === "Basic" && encoded) {
      // Split on the FIRST colon only. RFC 7617 bars a colon in the username but
      // allows one in the password, so splitting on every colon would truncate any
      // password containing one and make it permanently unusable.
      const decoded = Buffer.from(encoded, "base64").toString();
      const separator = decoded.indexOf(":");
      if (separator !== -1) {
        const givenUser = decoded.slice(0, separator);
        const givenPassword = decoded.slice(separator + 1);
        if (matches(givenUser, user) && matches(givenPassword, password)) return next();
      }
    }

    const err = new HttpError(401, "Authentication required", "DOCS_AUTH");
    err.headers = { "WWW-Authenticate": 'Basic realm="Resume94 API docs"' };
    return next(err);
  };
}
