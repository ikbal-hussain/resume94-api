import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { validateBody, HttpError } from "../middleware/errors.js";
import { COOKIE_NAME, cookieOptions, signToken } from "../middleware/auth.js";
import {
  registerSchema,
  loginSchema,
  updateProfileSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from "../schemas.js";
import { resetPasswordEmail } from "../services/mail/templates/resetPassword.js";

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

export function authRouter({ config, users, passwordResets, mail, withTransaction, requireAuth, testing, log = console }) {
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
    const ok = await bcrypt.compare(password, row?.passwordHash ?? DUMMY_HASH);
    if (!row || !ok) throw new HttpError(401, "Invalid email or password", "BAD_CREDENTIALS");
    res.json({ user: startSession(res, await users.findById(row._id.toString())) });
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
      const token = await passwordResets.create(row._id, config.RESET_TOKEN_TTL_MINUTES);
      const link = `${config.CLIENT_ORIGIN}/reset-password?token=${encodeURIComponent(token)}`;
      try {
        await mail.send(
          resetPasswordEmail({ to: row.email, name: row.name, link, ttlMinutes: config.RESET_TOKEN_TTL_MINUTES })
        );
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
