# Changelog

Notable changes to resume94-api. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

This project has no version tags yet, so releases are dated rather than numbered.
Every entry below corresponds to work that actually reached `main`.

## [Unreleased]

### Added
- `POST /api/auth/google` — signs in or registers from the ID token Google's sign-in
  button issues in the browser. The signature, issuer and audience are verified
  server-side; the session that follows is the ordinary one. Unset `GOOGLE_CLIENT_ID`
  disables it with a 503 rather than a half-working endpoint.
- `passwordHash` is now optional on a user, and `login` **refuses an account that never
  set one** rather than relying on bcrypt to reject a missing hash.
- A password-reset request for a Google-only account is answered by email explaining
  that it signs in with Google. The HTTP response is still an unconditional 204 —
  saying it there would undo the account-enumeration defence that endpoint exists for.
- `POST /api/ai/import` — parses the plain text of an existing resume into the app's
  structured shape, so a user can start from a resume they already have. The text is
  extracted in the browser, so the endpoint never handles a file. The model runs at
  temperature 0 and is told to copy rather than invent; its answer is parsed
  permissively, so one badly shaped field costs that field rather than the whole
  import. Limited to 5 requests per 10 minutes per user.
- `GET /api/resumes` now returns `headline`, `templateId` and `accentColor` alongside
  each summary, so the dashboard can draw a miniature of every resume without fetching
  the documents. Still a projection, not the whole document: a resume carries a base64
  photo of up to 1 MB, and a list of twenty would be twenty megabytes.
- JSON mode, temperature and per-call timeouts in the provider interface
  (`response_format` for Groq, `responseMimeType` for Gemini).
- `AGENTS.md`, `CLAUDE.md` and `ARCHITECTURE.md` — conventions for contributors and
  coding agents, and a written account of how the system works and why.

### Changed
- **Rate-limit counters live in Upstash Redis** when `UPSTASH_REDIS_REST_URL` and
  `UPSTASH_REDIS_REST_TOKEN` are set, instead of in each process. The default
  `MemoryStore` counts per serverless instance, so every configured limit was really
  that limit multiplied by however many instances were warm, and it reset on each cold
  start — the comment in `routes/ai.js` claiming the import limit capped what one
  account could spend in an afternoon was not true in production. One key per client
  per limiter, incremented by a Lua script so `INCR` and its TTL cannot come apart.
  Reached over Upstash's REST API, so there is no SDK dependency and no socket a
  serverless function cannot reuse.
  With the credentials unset the limiters fall back to the in-process store, which is
  correct for local work and the tests — so `/api/health` now reports `rateLimitStore`
  and `rateLimitStoreReachable`, and the smoke test **fails** on either `"memory"` or a
  store that does not answer. Reachability is probed rather than inferred, the way the
  database is pinged: a mistyped token would otherwise read as healthy while every AI
  request 503s and every other limit passes through uncounted. The probe is cached for
  30s because `/api/health` is public and Upstash meters commands.
- An `UPSTASH_REDIS_REST_URL` that is not `https://` is **refused**. The token is a
  bearer credential on every request and would otherwise cross the network in the clear.
- **A limiter now decides what a counter outage means.** The AI routes fail closed:
  an unreachable counter answers 503 (`RATE_LIMIT_UNAVAILABLE`), because those routes
  pay a provider per call and unmetered is worse than unavailable. Auth and resumes
  fail open, where an outage would only stop someone using their own account.
- The serverless function's `maxDuration` is raised to 60s. An import waits on a whole
  resume coming back from the provider, which does not fit in the 10s default.

### Fixed
- The auth limiters are **raised from 20 to 100 per 15 minutes** (register/login/google)
  and **from 5 to 20 per hour** (password reset), because moving to a shared store is
  what made them bind. They key on IP, and an IP is not a person: an office, a campus or
  a mobile carrier behind CGNAT is thousands of people on one address. At the old
  numbers — tuned when a cold start wiped the counter and each instance kept its own —
  the first real incident would have been a shared network locked out of signing in.
- The resume limiter's `keyGenerator` read `req.ip` directly as its fallback, which
  express-rate-limit flags as `ERR_ERL_KEY_GEN_IPV6` — and only *logs*, so it was easy
  to miss. An IPv6 client can take a fresh address at will, and counting the raw
  address handed out a fresh bucket with it. It now goes through `ipKeyGenerator`,
  which counts the /56 subnet.
- `.env.example` had the Google sign-in block spliced into the middle of the
  password-reset comment, leaving a stray `MAIL_PROVIDER=resend to send for real.`
  line. Copying the file set `MAIL_PROVIDER` twice.

### Security
- The prompt fence markers are stripped from user content before it is fenced. Text
  containing `CONTENT>>>` would previously have closed the fence early, leaving the
  rest of itself to be read as prompt. Affects `/ai/improve` as well as the new import.

### Fixed
- A provider responding 200 with a non-JSON body now reports `AI_UPSTREAM` (502)
  instead of throwing past the error handler as a generic 500.
- Import requests are validated before the rate limiter is consulted, so a malformed
  request can no longer spend an import from the 5-per-10-minutes budget without a
  provider call having been made.
- The JSON object is located by matching braces rather than slicing from the first `{`
  to the last `}`, so a brace in a preamble — `Here is the result {as requested}: {…}` —
  no longer fails a reply whose JSON was valid. Braces inside string values are
  skipped, and when a reply holds more than one object the largest is taken.
- The import's documented response is `ImportedResumeData` rather than `ResumeData`.
  It never returns `templateId`, `accentColor`, `sectionOrder` or `profileImage`, and
  the schema said otherwise.

### Known
- The function is deployed to `iad1` (Washington DC) while MongoDB Atlas is in
  `ap-south-1` (Mumbai), costing ~200 ms per database round trip. Measured. The fix is
  a `regions` pin in `vercel.json`.
- Rate limits use an in-memory store and are therefore per serverless instance.

## [2026-09-27]

### Added
- Post-deploy smoke test (`scripts/smoke.mjs`) and the workflow that runs it against
  production after every push to `main`. It waits for `/api/health` to report the
  pushed commit before asserting anything, so it cannot pass against the deployment it
  is replacing.
- `/api/health` now reports the running commit, the AI provider and whether it is
  configured, and the mail provider and whether it is configured.

### Changed
- `/api/docs` and `/api/openapi.json` report 404 in production unless `DOCS_USER` and
  `DOCS_PASSWORD` are set, in which case they sit behind basic auth. Credentials are
  compared with `timingSafeEqual`.
- The service root no longer links to the documentation.

### Fixed
- A missing mail setting no longer takes the whole API down. A startup throw added for
  the mail transport had made every route — auth, resumes and AI — return 500, with a
  green test suite and a successful deploy report. This is the incident the smoke test
  exists to catch.
- Basic-auth credentials are split on the first colon only (RFC 7617 permits a colon in
  the password), so a password containing one is no longer truncated.

## [2026-09-26]

### Added
- Password reset by emailed single-use link: `POST /auth/forgot-password`,
  `GET /auth/reset-password/:token`, `POST /auth/reset-password`.
- Resend mail provider, with a `console` provider that prints the link to the server
  log so local development needs no email account.
- TTL index on `passwordResets.expiresAt` so Mongo clears spent tokens.

### Security
- Only the hash of a reset token is stored, so a database leak does not yield working
  reset links.
- `forgot-password` returns the same response whether or not the address has an
  account, closing an account-existence oracle.

### Fixed
- Token creation and consumption now commit as a single transaction, so a partial
  failure cannot leave a token spent with the password unchanged.

## [2026-09-25]

### Fixed
- swagger-ui's static assets are bundled into the Vercel function via `includeFiles`.
  Vercel traces JS imports only, so `/api/docs` had been loading with no scripts.

## [2026-09-24]

### Added
- Structured resume sections — roles, dates, bullets, grouped skills — replacing the
  original free-text-per-section model.
- Migration of legacy documents on read. Anything that cannot be confidently parsed
  into the new shape is preserved rather than dropped.
- OpenAPI document generated from the Zod validators the routes already enforce, served
  at `/api/openapi.json` with Swagger UI at `/api/docs`.

### Fixed
- Every path is routed to the serverless function, and the bare domain returns a
  service identity response instead of a 404 that looks like a broken deployment.
- Vercel's auto-detected Express framework preset is disabled; it was interfering with
  the explicit build configuration.

## [2026-09-23]

### Added
- Pluggable AI provider registry. `AI_PROVIDER` selects between Gemini and Groq; each
  provider is one file behind a shared interface.

### Fixed
- Corrected the default Groq model id.
- Upstream AI failures are translated into actionable errors — a rejected key, an
  unavailable model and a provider rate limit are now distinguishable, with the
  provider's response body logged server-side.

## [2026-09-21]

### Added
- Initial API: Express 5 on Node 20+, MongoDB, deployed as a Vercel serverless
  function.
- Email/password authentication with bcrypt and a JWT in an `httpOnly`,
  `SameSite=Lax` cookie.
- Resume CRUD plus duplicate, with every query scoped to the owning user (a foreign id
  returns 404, never 403).
- AI proxy endpoints (`/api/ai/summary`, `/api/ai/improve`) so the provider key never
  reaches the browser, with a per-user rate limit.
- Zod validation on every request body, helmet, CORS with credentials, a 2 MB body cap
  and rate limits on the auth routes.
- Vitest + Supertest suite running against a real in-memory MongoDB.
