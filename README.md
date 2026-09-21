# Resume94 API

REST API for [Resume94](https://github.com/ikbal-hussain/AI-Resume-Maker), an AI resume builder. Node 20+, Express 5, MongoDB, deployed as a Vercel serverless function.

- **Auth**: email/password (bcrypt), JWT in an `httpOnly`, `SameSite=Lax` cookie
- **Resumes**: CRUD + duplicate; every query is scoped to the owner (foreign ids → 404)
- **AI**: Gemini proxy (`/api/ai/summary`, `/api/ai/improve`) so the provider key never reaches the browser; per-user rate limit
- **Validation**: Zod on every body; helmet; body size cap; auth rate limits
- **Tests**: Vitest + Supertest against an in-memory MongoDB (`mongodb-memory-server`), 18 tests

## Endpoints (all under `/api`)
Errors are `{ "error": { "code", "message", "details?" } }`.

| Method & path | Description |
|---|---|
| `POST /auth/register` `{name,email,password}` | Create account + session (201) |
| `POST /auth/login` | Start session |
| `POST /auth/logout` | Clear session (204) |
| `GET/PATCH/DELETE /auth/me` | Current user / rename / delete account and resumes |
| `GET /resumes` · `POST /resumes` | List summaries · create |
| `GET/PUT/DELETE /resumes/:id` | Read / replace / delete |
| `POST /resumes/:id/duplicate` | Copy |
| `POST /ai/summary` · `POST /ai/improve` | AI text generation |
| `GET /health` | Liveness + DB ping |

## Run locally
```bash
npm install
cp .env.example .env     # set MONGODB_URI, JWT_SECRET (and GEMINI_API_KEY)
npm run dev              # http://localhost:4100
npm test
```

## Deploy (Vercel)
`api/index.js` is the serverless entry; `vercel.json` rewrites `/api/*` to it. Set env vars `MONGODB_URI`, `JWT_SECRET`, `GEMINI_API_KEY` (optional), `CLIENT_ORIGIN`. In MongoDB Atlas allow network access from `0.0.0.0/0` (Vercel has no fixed IPs) and use a least-privilege DB user.

The frontend project proxies `/api/*` to this deployment with a Vercel rewrite, so the browser only talks to its own origin and the session cookie stays first-party (works in Safari).

## Design notes
- **Serverless connection reuse**: the app and Mongo client are cached on the warm instance; init retries after failure.
- **Rate limits are per instance** (in-memory store). On serverless they are best-effort; a production setup would use Redis/Upstash.
- **Unique email** is enforced by a unique index, so concurrent sign-ups can't create duplicates.
- **Stateless JWT** can't be revoked before expiry — upgrade path is short-lived access + rotating refresh tokens.
