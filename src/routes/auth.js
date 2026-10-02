import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { validateBody, HttpError } from "../middleware/errors.js";
import { COOKIE_NAME, cookieOptions, signToken } from "../middleware/auth.js";
import {
  registerSchema,
  loginSchema,
  googleAuthSchema,
  updateProfileSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from "../schemas.js";
import { resetPasswordEmail } from "../services/mail/templates/resetPassword.js";
import { googleAccountEmail } from "../services/mail/templates/googleAccount.js";

// Used to keep login timing similar whether or not the email exists.
const DUMMY_HASH = bcrypt.hashSync("dummy-password", 10);

// Floor for the forgot-password response, comfortably above a typical provider round
// trip so both the registered and unknown paths take about the same time.
const RESPONSE_FLOOR_MS = 600;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const padTo = async (floorMs, startedAt, skip) => {
  if (skip) return; // tests would otherwise pay the floor on every call
  const remaining = floorMs - (Date.now() - startedAt);
  if (remaining > 0) await sleep(remaining);
};

export function authRouter({ config, users, passwordResets, mail, google, withTransaction, requireAuth, testing, log = console }) {
  const r = Router();
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => testing,
    message: { error: { code: "RATE_LIMITED", message: "Too many attempts, try again later" } },
  });

  // Tighter than the shared limiter: each request sends real mail to a third party,
  // so this endpoint is the one worth abusing.
  const resetLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => testing,
    message: { error: { code: "RATE_LIMITED", message: "Too many reset requests, try again later" } },
  });

  // Generous by comparison: one page load spends a single call, but the endpoint is
  // unauthenticated, so it should not be an unmetered route to the database.
  const probeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => testing,
    message: { error: { code: "RATE_LIMITED", message: "Too many attempts, try again later" } },
  });

  const startSession = (res, user) => {
    res.cookie(COOKIE_NAME, signToken(config, user.id), cookieOptions(config));
    return user;
  };

  r.post("/register", limiter, validateBody(registerSchema), async (req, res) => {
    const { name, email, password } = req.body;
    if (await users.findCredentialsByEmail(email)) throw new HttpError(409, "Email already registered", "EMAIL_TAKEN");
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await users.create({ name, email, passwordHash });
    if (!user) throw new HttpError(409, "Email already registered", "EMAIL_TAKEN"); // lost a race
    res.status(201).json({ user: startSession(res, user) });
  });

  r.post("/login", limiter, validateBody(loginSchema), async (req, res) => {
    const { email, password } = req.body;
    const row = await users.findCredentialsByEmail(email);
    // A Google-only account has no hash. Comparing against the dummy keeps the timing
    // identical to an unknown address, and `row.passwordHash` is checked separately so a
    // missing hash can never be the thing that passes — bcrypt.compare(x, undefined)
    // rejects today, but relying on that is one library change away from failing open.
    const ok = await bcrypt.compare(password, row?.passwordHash || DUMMY_HASH);
    if (!row || !row.passwordHash || !ok) throw new HttpError(401, "Invalid email or password", "BAD_CREDENTIALS");
    res.json({ user: startSession(res, await users.findById(row._id.toString())) });
  });

  /**
   * Sign in or register with a Google ID token.
   *
   * The browser gets the token from Google's own button and posts it here once; the
   * signature, issuer and audience are checked server-side before any of it is believed.
   * From there it is an ordinary session — the same cookie every other route sets.
   */
  r.post("/google", limiter, validateBody(googleAuthSchema), async (req, res) => {
    if (!google.configured) {
      throw new HttpError(503, "Google sign-in is not configured on this server", "GOOGLE_NOT_CONFIGURED");
    }

    let claims;
    try {
      claims = await google.verify(req.body.credential);
    } catch (err) {
      // The reason is for us, not for the caller: "wrong audience" and "expired" are
      // both just an unusable token from outside, and spelling out which one helps
      // nobody but someone probing the endpoint.
      log.error?.(`[google] token rejected: ${err.message}`);
      throw new HttpError(401, "That Google sign-in could not be verified", "GOOGLE_TOKEN_INVALID");
    }

    const { sub, email, emailVerified, name, picture } = claims;
    if (!sub || !email) throw new HttpError(401, "That Google sign-in could not be verified", "GOOGLE_TOKEN_INVALID");

    // Already linked: the subject id is the identity, not the address. Google addresses
    // can change, and matching on the id means a changed address still signs in here.
    const linked = await users.findByGoogleId(sub);
    if (linked) return res.json({ user: startSession(res, await users.findById(linked._id.toString())) });

    const normalisedEmail = email.trim().toLowerCase();
    const existing = await users.findCredentialsByEmail(normalisedEmail);

    if (existing) {
      // The whole defence. Without this check, anyone who can persuade Google to issue a
      // token for an address takes over the Resume94 account holding it. Refused rather
      // than given a second account, because two accounts for one address is worse.
      if (!emailVerified) {
        throw new HttpError(
          403,
          "Google has not verified this email address, so it cannot be linked to an existing account",
          "GOOGLE_EMAIL_UNVERIFIED"
        );
      }
      const user = await users.linkGoogle(existing._id, { googleId: sub, avatarUrl: picture ?? null });
      // Null means the account already carries a different Google identity.
      if (!user) throw new HttpError(409, "This account is already linked to a different Google account", "GOOGLE_ALREADY_LINKED");
      return res.json({ user: startSession(res, user) });
    }

    // New account. An unverified address is refused here too: registering it would let
    // someone claim an address they do not own and sit on it before the real owner signs up.
    if (!emailVerified) {
      throw new HttpError(403, "Google has not verified this email address", "GOOGLE_EMAIL_UNVERIFIED");
    }

    const user = await users.create({
      name: (name || normalisedEmail.split("@")[0]).slice(0, 80),
      email: normalisedEmail,
      googleId: sub,
      avatarUrl: picture ?? null,
    });
    // Lost a race with another sign-up for the same address.
    if (!user) throw new HttpError(409, "Email already registered", "EMAIL_TAKEN");
    res.status(201).json({ user: startSession(res, user) });
  });

  // Always 204, whether or not the address has an account. Reporting "no such user"
  // would turn this into a free oracle for discovering who is registered here.
  //
  // The status code alone is not enough: a registered address costs a token insert and
  // a round trip to the mail provider, an unknown one costs nothing, and that gap is
  // large enough to measure. Both paths are therefore held to a common floor. A send
  // slower than the floor still shows through — removing the signal completely means
  // handing delivery to a job queue and answering before it runs.
  r.post("/forgot-password", resetLimiter, validateBody(forgotPasswordSchema), async (req, res) => {
    const startedAt = Date.now();
    const row = await users.findCredentialsByEmail(req.body.email);
    if (row) {
      // An account created through Google has no password to reset. The answer goes to
      // the inbox rather than into the response: saying it here would tell any caller
      // that the address is registered, which is the exact thing the uniform 204 hides.
      // Silence would be worse than either — the person is locked out and told nothing.
      const message = row.passwordHash
        ? resetPasswordEmail({
            to: row.email,
            name: row.name,
            link: `${config.CLIENT_ORIGIN}/reset-password?token=${encodeURIComponent(
              await passwordResets.create(row._id, config.RESET_TOKEN_TTL_MINUTES)
            )}`,
            ttlMinutes: config.RESET_TOKEN_TTL_MINUTES,
          })
        : googleAccountEmail({ to: row.email, name: row.name, signInUrl: `${config.CLIENT_ORIGIN}/auth/sign-in` });
      try {
        await mail.send(message);
      } catch (err) {
        // A delivery failure must not change the response, or the timing difference
        // leaks the same fact the uniform status code is hiding.
        log.error(`[mail] reset delivery failed: ${err.message}`);
      }
    }
    await padTo(RESPONSE_FLOOR_MS, startedAt, testing);
    res.status(204).end();
  });

  // Lets the reset page say "this link has expired" before the user types a password.
  // Limited too: it is unauthenticated and hits the database on every call, and the
  // reset limiter above does not cover it.
  r.get("/reset-password/:token", probeLimiter, async (req, res) => {
    res.json({ valid: Boolean(await passwordResets.findValid(req.params.token)) });
  });

  r.post("/reset-password", resetLimiter, validateBody(resetPasswordSchema), async (req, res) => {
    // Hashed before the transaction opens: bcrypt is deliberately slow and holding a
    // transaction across it would keep locks for no reason.
    const passwordHash = await bcrypt.hash(req.body.password, 10);

    // Checking, burning and updating together as one unit. Apart, a crash between the
    // last two leaves the password changed with every link still live — and two requests
    // carrying the same token could both pass the check before either burned it.
    const userId = await withTransaction(async (session) => {
      const row = await passwordResets.findValid(req.body.token, session);
      if (!row) throw new HttpError(400, "This reset link is invalid or has expired", "RESET_TOKEN_INVALID");

      await passwordResets.consume(row.userId, session); // this token and any siblings
      await users.updatePasswordHash(row.userId, passwordHash, session);
      return row.userId;
    });

    // The account can be deleted between a link being issued and used, which would
    // otherwise leave startSession dereferencing null and returning a 500.
    const user = await users.findById(userId.toString());
    if (!user) throw new HttpError(400, "This reset link is invalid or has expired", "RESET_TOKEN_INVALID");

    res.json({ user: startSession(res, user) }); // signed straight in
  });

  r.post("/logout", (_req, res) => {
    res.clearCookie(COOKIE_NAME, { ...cookieOptions(config), maxAge: undefined });
    res.status(204).end();
  });

  r.get("/me", requireAuth, (req, res) => res.json({ user: req.user }));

  r.patch("/me", requireAuth, validateBody(updateProfileSchema), async (req, res) => {
    res.json({ user: await users.updateName(req.user.id, req.body.name) });
  });

  r.delete("/me", requireAuth, async (req, res) => {
    await users.delete(req.user.id); // also removes the user's resumes
    res.clearCookie(COOKIE_NAME, { ...cookieOptions(config), maxAge: undefined });
    res.status(204).end();
  });

  return r;
}
