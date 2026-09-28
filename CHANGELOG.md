# Changelog

Notable changes to resume94-api. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

This project has no version tags yet, so releases are dated rather than numbered.
Every entry below corresponds to work that actually reached `main`.

## [Unreleased]

### Added
- `POST /api/ai/import` — parses the plain text of an existing resume into the app's
  structured shape, so a user can start from a resume they already have. The text is
  extracted in the browser, so the endpoint never handles a file. The model runs at
  temperature 0 and is told to copy rather than invent; its answer is parsed
  permissively, so one badly shaped field costs that field rather than the whole
  import. Limited to 5 requests per 10 minutes per user.
- JSON mode, temperature and per-call timeouts in the provider interface
  (`response_format` for Groq, `responseMimeType` for Gemini).
- `AGENTS.md`, `CLAUDE.md` and `ARCHITECTURE.md` — conventions for contributors and
  coding agents, and a written account of how the system works and why.

### Changed
- The serverless function's `maxDuration` is raised to 60s. An import waits on a whole
  resume coming back from the provider, which does not fit in the 10s default.

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
