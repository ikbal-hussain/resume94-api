# Working in this repository

Guidance for coding agents (Claude Code, Cursor, Copilot and friends) and for humans
who want the conventions written down. `CLAUDE.md` points here so there is one file
to keep current instead of two that drift apart.

Read `ARCHITECTURE.md` first if you need to know *how the system works*. This file is
about *how to change it*.

## What this is

The REST API behind [Resume94](https://github.com/ikbal-hussain/AI-Resume-Maker).
Express 5 on Node 20+, MongoDB Atlas, deployed as a single Vercel serverless function.
The frontend is a separate repository and a separate deployment.

## Commands

```bash
npm run dev      # node --watch on :4100, reads .env if present
npm test         # vitest run — 74 tests, real Mongo in memory, no mocks of the DB
npm run lint     # eslint
npm run smoke    # scripts/smoke.mjs against the live deployment (not localhost)
```

`npm test` needs no running database: `mongodb-memory-server` starts a real replica set
per suite. The first run downloads a Mongo binary and is slow; later runs are not.

## Conventions

**Layers, and what belongs in each.** A route handles HTTP and nothing else; a
repository owns the query; a service owns a third-party integration. A route that
builds a Mongo filter, or a repository that reads `req`, is in the wrong place.

```
routes/      HTTP: validate, call, shape the response
repositories/  Mongo access. The ONLY place a collection is touched
services/    AI and mail providers, each behind a small interface
middleware/  auth, errors, docs guard
```

**Dependencies are injected, never imported by the thing that uses them.**
`createApp(config, { db, client, ai, mail, log })` takes everything it needs as an
argument, which is what lets the tests swap in an in-memory database and a fake AI
provider without mocking modules. Keep it that way — a new `import` of a live service
inside a route is how that property gets lost.

**Validate every body with Zod, in `src/schemas.js`.** Routes apply it through
`validateBody(schema)`. The OpenAPI document is generated from those same schemas via
`z.toJSONSchema`, so documentation cannot drift from what the route accepts. Adding a
field means editing one schema, not two.

**Scope every query by owner.** Resume queries are built through
`scope(userId, id)`, which puts `userId` in the filter itself. Do not fetch a document
and then compare owners in JavaScript — a missed check is a data leak, whereas a missed
`userId` in the filter produces a 404 and a failing test. Another account's id must be
indistinguishable from one that does not exist: **404, never 403.**

**Errors go through `HttpError` and the central handler.** Throw
`new HttpError(status, message, code)`; never call `res.status(...).json(...)` for an
error case in a route. The client contract is
`{ "error": { "code", "message", "details?" } }` and the handler is the only place that
knows it.

**Comments explain why, not what.** The existing comments in this repo record the
reasoning behind a non-obvious decision — why the docs 404 instead of prompting, why
the basic-auth header is split on the first colon only, why `appPromise` is reset on
failure. Match that. A comment restating the line below it is noise; delete it.

## Things that will bite you

- **`NODE_ENV` defaults to `"production"`** (`src/config.js`). A host that forgets to
  set it fails closed — cookie `Secure`, the `JWT_SECRET` requirement, the mail
  transport check and the docs guard all stay strict. Set `NODE_ENV=development`
  locally or you will be debugging a cookie that never arrives.
- **Rate limits use `MemoryStore`, which is per serverless instance.** The effective
  limit is the configured one multiplied by however many instances are warm, and it
  resets on every cold start. This is a known gap, tracked, and the fix is a shared
  Redis store. Do not write a test or a claim that treats the limit as exact.
- **Transactions need a replica set.** Atlas is one, a standalone local `mongod` is
  not. `makeWithTransaction` probes once and degrades to sequential writes with a
  warning, so local work keeps going — but a multi-write flow is only atomic in
  production and in the tests.
- **Vercel traces JS imports only.** Assets that are read from disk at runtime need an
  explicit `includeFiles` in `vercel.json`. This is why swagger-ui is listed there; it
  loaded with no scripts until it was.
- **Never send a secret to the browser.** The AI provider key lives only in this
  process. Every AI feature is a server-side proxy for that reason, not for convenience.

## Tests

Vitest + Supertest, hitting the real Express app over HTTP against a real in-memory
Mongo. There are no unit tests of repositories in isolation and that is deliberate:
the behaviour worth protecting is "this request, from this user, gets this status".

A new endpoint needs, at minimum: the happy path, the unauthenticated path (401), and —
if it touches a user-owned document — a test proving another account gets 404.

## Deployment

`api/index.js` is the serverless entry; `vercel.json` routes every path to it.
Pushing to `main` deploys, then `.github/workflows/smoke.yml` runs `scripts/smoke.mjs`
against production. The smoke test waits for `/api/health` to report the pushed commit
before it asserts anything, so it cannot pass against the build it is replacing.

If you add a dependency the deployment cannot start without, add a check for it to
`/api/health` and a corresponding assertion to the smoke test. A `MAIL_PROVIDER` left
at `"console"` in production is invisible from every other endpoint until a user
requests a password reset — that is the class of failure the health payload exists to
catch.

## Git

Branch from `main`, one concern per branch. Commit subjects are lowercase,
`type: imperative summary` (`feat:`, `fix:`, `chore:`, `ci:`, `docs:`).

Do not push to a branch whose pull request has already been merged — GitHub accepts the
push silently and the commit is stranded outside `main`. It has happened three times in
this project. After a merge, start a new branch.
