import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { validateBody, HttpError } from "../middleware/errors.js";
import { COOKIE_NAME, cookieOptions, signToken } from "../middleware/auth.js";
import { registerSchema, loginSchema, updateProfileSchema } from "../schemas.js";

// Used to keep login timing similar whether or not the email exists.
const DUMMY_HASH = bcrypt.hashSync("dummy-password", 10);

export function authRouter({ config, users, requireAuth, testing }) {
  const r = Router();
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
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
