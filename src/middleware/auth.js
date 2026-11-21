import jwt from "jsonwebtoken";
import { HttpError } from "./errors.js";

export const COOKIE_NAME = "token";

export function cookieOptions(config) {
  return {
    httpOnly: true, // not readable from JS → mitigates token theft via XSS
    sameSite: "lax", // blocks cross-site POSTs → baseline CSRF protection
    secure: config.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  };
}

export const signToken = (config, userId) =>
  jwt.sign({ sub: String(userId) }, config.JWT_SECRET, { expiresIn: config.JWT_EXPIRES_IN });

/**
 * The signed-in user, or null when there is no valid session: no cookie, a token that
 * fails verification, or an account that no longer exists. A database error is not
 * "signed out" and is left to throw, so an outage surfaces as a 5xx instead of quietly
 * logging everyone out.
 */
export async function readSession(config, users, req) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return null;
  let sub;
  try {
    ({ sub } = jwt.verify(token, config.JWT_SECRET));
  } catch {
    return null;
  }
  return (await users.findById(sub)) ?? null;
}

export const requireAuth = (config, users) => async (req, _res, next) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return next(new HttpError(401, "Authentication required", "UNAUTHENTICATED"));
  try {
    const { sub } = jwt.verify(token, config.JWT_SECRET);
    const user = await users.findById(sub);
    if (!user) throw new Error("user gone");
    req.user = user;
    next();
  } catch {
    next(new HttpError(401, "Invalid or expired session", "UNAUTHENTICATED"));
  }
};
