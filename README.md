# KachPloy

KachPloy connects homeowners with trusted service providers. From plumbers to cleaners, users can search, book, and manage home services in one place.

---

## Deployment and staging

The repository contains two applications:

| Path | What it is | Runtime |
|---|---|---|
| `server/` | Express + Firebase Admin API | Node 20 |
| `client/` | React + Vite single-page app | Node 20 for builds; static host at runtime |

Node **20** is required. The backend uses `node:test` and the global `fetch`; the client is built with Vite.

> **Staging status:** this document describes how to prepare a staging deployment. It does not establish production readiness, Paystack production approval, or complete environment isolation.

### Staging architecture

| Item | Current status |
|---|---|
| Staging frontend URL | Not selected |
| Staging backend URL | Not selected |
| Hosting provider | Not selected |
| Firebase project | `pet-idea`, shared with development |
| Firebase Auth | Shared with development |
| Firestore | Shared with development |
| Paystack environment | Test Mode only |
| Live payouts | Disabled |
| Cloudinary | Shared account unless a separate one is provided; use a staging folder prefix |

Firebase is deliberately reused between development and staging for now. This keeps staging cheap to operate, but it is a development/staging compromise, **not full environment isolation**:

- Staging users, jobs, applications, contracts, tasks and other Firestore records live in the same database as development records.
- Staging authentication accounts are real accounts in the shared Firebase project.
- A developer using the same Firebase project can see and modify staging data, and staging can see development data.
- The application does not add a general deployment/environment tag to Firestore documents. Payment records have a Paystack `providerEnvironment` of `test` or `live`, but that cannot distinguish development from staging when both use Test Mode.
- Use dedicated test accounts and recognizable names, emails or identifiers for staging data. Never load real user data into staging.
- Review records before any destructive operation. Do not bulk-delete or clean up Firestore data until every affected record has been identified as staging-only.

Full isolation would require a separate Firebase project and separate provider accounts. Neither is part of the current staging setup.

### Local setup

Backend:

```bash
cd server
npm ci
cp .env.example .env        # edit .env with local values; never commit it
npm start                   # node ./bin/www
npm test                    # node --test test/
```

`npm start` reads `PORT` from the environment and falls back to Express's default port when it is absent. There is no hot reload; restart the process after server changes.

Frontend:

```bash
cd client
npm ci
npm run dev
npm test                    # node --test test/
npm run lint
```

Use `npm ci` in deployment/build environments so the committed lockfiles are honoured. Use `npm install` only when intentionally changing dependencies.

### Frontend configuration

The frontend reads `import.meta.env.VITE_API_URL` in `client/src/api.js`:

- When `VITE_API_URL` is set, all API calls use it.
- When it is unset, local development falls back to `http://localhost:3000`.
- Production builds fail if `VITE_API_URL` is missing. `client/vite.config.js` enforces this before Vite emits `client/dist/`.
- The staging build must point at the staging backend, not localhost.

`client/.env.example` contains placeholders only. Do not commit real values.

Build the client with the staging API origin supplied at build time:

```bash
cd client
VITE_API_URL=https://<staging-backend-host> npm run build
```

PowerShell equivalent:

```powershell
cd client
$env:VITE_API_URL='https://<staging-backend-host>'
npm run build
```

Vite inlines the value into the generated bundle, so changing the backend URL requires rebuilding the client. The Firebase web configuration is also supplied through `VITE_FIREBASE_*` variables; see `client/.env.example` for the full list.

`client/dist/` is static and can be served by any static host or CDN. Because this is a single-page app, the host must rewrite unknown paths to `index.html`.

### Backend configuration

`server/.env.example` is the authoritative template. The staging deployment should set the following values in the host's environment or secret store.

| Variable | Staging requirement | Purpose |
|---|---|---|
| `NODE_ENV` | Required: `production` | Enables production error redaction and production CORS/rate-limit defaults |
| `CORS_ORIGINS` | Required | Comma-separated exact browser origins allowed to call the API |
| `PORT` | Optional; host-dependent | HTTP port; Express uses its default when absent |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | Optional | Path to the Firebase service-account JSON when it is not in the default location |
| `CLOUDINARY_CLOUD_NAME` | Required for uploads | Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | Required for uploads | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Required for uploads | Cloudinary secret; never leaves the server |
| `CLOUDINARY_FOLDER_PREFIX` | Recommended: `kachploy/staging` | Isolates staging upload paths within the Cloudinary account |
| `PAYSTACK_MODE` | Required: `test` | Selects Paystack Test Mode explicitly |
| `PAYSTACK_SECRET_KEY` | Required for payments | A Test Mode secret key beginning with `sk_test_` |
| `PAYSTACK_LIVE_PAYOUTS_ENABLED` | Required: `false` | Keeps transfer/payout submission blocked |
| `TRUST_PROXY` | Optional; default `false` | Exact number of trusted reverse-proxy hops |
| `REQUEST_BODY_LIMIT` | Optional; default `1mb` | Maximum JSON body size |
| `URLENCODED_BODY_LIMIT` | Optional; default `100kb` | Maximum URL-encoded body size |
| `REQUEST_TIMEOUT_MS` | Optional; default `30000` | Whole-request timeout |
| `HEADERS_TIMEOUT_MS` | Optional; default `15000` | Request-header timeout |
| `KEEP_ALIVE_TIMEOUT_MS` | Optional; default `5000` | Keep-alive timeout |
| Rate-limit variables | Optional | Override the production defaults documented below |

Notes:

- **Firebase:** the server reads a service-account JSON file, not individual Firebase environment variables. If `FIREBASE_SERVICE_ACCOUNT_PATH` is set, it must not be blank; the path must point to a readable JSON file. If it is unset, the server uses its bundled default credential file under `server/config/`. The server fails at startup if the credential is missing or invalid. The credential file is gitignored and must be mounted or otherwise placed on the host out-of-band.
- **Cloudinary:** the three credential variables are optional for non-upload features. When any is missing, upload-signing and private-asset operations answer `503`; text/link task submissions and the rest of the API keep working. `/ready` reports Cloudinary as not configured.
- **Paystack:** the key is optional for non-payment features. When the key is missing, invalid for the selected mode, or the mode is invalid, payment endpoints answer `503` and `/ready` reports Paystack as not configured.
- **CORS:** in production, an empty `CORS_ORIGINS` refuses every browser origin. Requests without an `Origin` header, such as server-to-server calls, curl and Paystack webhooks, are not blocked by CORS.
- **Trusted proxy:** leave `TRUST_PROXY=false` when the app is directly reachable. Behind a reverse proxy, set the exact hop count (for example, `1`). Only `false`, `0`, or a positive integer is accepted; `true` is rejected. Review this after the hosting provider is selected, because an incorrect value affects client IPs and rate limiting.
- **Unsupported variable:** `PAYSTACK_PUBLIC_KEY` is not read by this server. It may exist in old `.env` files but is not required.

Never commit `.env` files or Firebase service-account credentials. They are gitignored; keep them that way.

### Paystack safety

Staging must remain in **Test Mode**:

- Set `PAYSTACK_MODE=test`.
- Use a Test Mode secret key beginning with `sk_test_`.
- Set `PAYSTACK_LIVE_PAYOUTS_ENABLED=false`.
- Do not use real money for employer payments or freelancer payouts.
- Do not enable Live Mode or live payouts to test staging.

The server supports explicit Live Mode configuration, but that capability is not a staging instruction and must not be used here. Live payouts require both Live Mode and the separate live-payout opt-in; staging must keep the opt-in disabled.

Paystack webhook endpoint:

```text
POST /payments/webhook
```

Register the deployed backend URL in the Paystack dashboard, for example `https://<staging-backend-host>/payments/webhook`. The endpoint authenticates each delivery with an HMAC-SHA512 signature over the raw request body. Requirements:

1. The reverse proxy or gateway must forward the body byte-for-byte and must not re-encode JSON.
2. Paystack must be able to reach the URL over HTTPS.
3. Use the dashboard's test-event delivery to verify connectivity after deployment.

**Cross-environment risk:** development and staging both use Paystack Test Mode. If they share a Test account or webhook endpoint, one deployment's Test event can reconcile a payment record in the other deployment. A separate Test Mode account or verified webhook isolation is still outstanding. Shared Firebase access makes this more consequential because both deployments also share the same Firestore data.

Passing automated tests does not establish Paystack production approval, live-mode readiness, or suitability for real-money transactions.

### Cloudinary isolation

Staging should set:

```text
CLOUDINARY_FOLDER_PREFIX=kachploy/staging
```

The prefix is prepended to the logical folders used for:

- profile photos: `profilePics/{uid}`
- resumes: `resumes/{uid}`
- task submissions: `taskSubmissions/{taskId}`

With the recommended value, an upload lands under paths such as `kachploy/staging/profilePics/{uid}`. The same prefixed path is used for upload signing, ownership validation, profile-photo URL derivation and deletion, resume validation and task-submission validation.

- A blank prefix preserves the historical unprefixed folders.
- Unsafe prefixes are rejected so Cloudinary operations fail closed instead of escaping the configured namespace.
- Existing unprefixed development assets must not be deleted to prepare staging.
- Upload new staging assets under the staging prefix. Existing unprefixed staging assets are not automatically adopted by the prefix and may need to be re-uploaded.
- `/ready` checks that Cloudinary credentials are present; it does not validate the folder prefix or contact Cloudinary. Verify the signed folder in a staging upload smoke test.

### Security and operations

The H1 hardening is active:

- Helmet security headers are enabled and `x-powered-by` is disabled.
- JSON and URL-encoded body sizes are limited before routes run.
- HTTP request, header and keep-alive timeouts are configured.
- CORS is pinned to `CORS_ORIGINS` in production.
- Production error responses are redacted JSON; full errors remain in server logs.
- Rate limiting is enabled globally and on scoped routes.

Production rate-limit defaults, per 15-minute window:

| Scope | Default maximum |
|---|---|
| General | 300 |
| Auth | 20 |
| Payment | 30 |
| Release | 20 |
| Upload | 30 |
| Webhook | 120 |

`/health`, `/ready` and `/payments/webhook` are skipped by the general limiter; the webhook has its own limiter. Rate-limit counters are in memory and are per server process. A multi-instance deployment needs a shared rate-limit store, which is not implemented here. Review the limits and the trusted-proxy setting after the hosting provider and instance count are known.

Health and readiness endpoints are public and unauthenticated:

| Endpoint | Meaning | Behaviour |
|---|---|---|
| `GET /health` | Liveness | Always `200 {"status":"ok"}` while the process is alive |
| `GET /ready` | Readiness | `200` when database, Cloudinary and Paystack configuration checks pass; `503` otherwise |

`/ready` checks configuration presence/shape and never contacts Firebase, Cloudinary or Paystack. It does not prove provider reachability, webhook delivery or Cloudinary folder-prefix correctness. Point liveness probes at `/health` and readiness probes at `/ready`; do not route traffic on a failed readiness check.

### Staging smoke tests

Perform these checks with staging accounts and test data only. Do not use real money, real user data or live provider credentials.

1. Confirm `GET /health` returns `200`.
2. Confirm `GET /ready` returns `200` only after Firebase, Cloudinary and Test Mode Paystack settings are present. A `503` is expected when an optional integration is intentionally unconfigured.
3. Confirm the staging frontend loads from its selected URL and browser API requests target the staging backend, not `localhost`.
4. Sign in with a dedicated staging test account, update a profile, and confirm the changes are visible in the shared Firebase project.
5. Request a profile-photo or resume upload signature and confirm the returned folder begins with `kachploy/staging/`.
6. Run a Test Mode payment flow only if needed, using Paystack test instructions. Confirm no live charge or payout is created.
7. Send a Paystack test webhook event only after confirming which Test account and Firebase data it can affect. Coordinate with development users if the account or endpoint is shared.
8. Verify CORS with the staging frontend origin and confirm an unlisted origin receives no `Access-Control-Allow-Origin` header.
9. Do not delete shared Firestore or Cloudinary data as part of smoke-test cleanup.

### Verification commands

Install dependencies from the committed lockfiles:

```bash
cd server && npm ci
cd ../client && npm ci
```

Client checks:

```bash
cd client
npm test
npm run lint
VITE_API_URL=https://<staging-backend-host> npm run build
```

Server checks:

```bash
cd server
node --test test/paystack-config.test.js test/paystack-webhook.test.js test/security-hardening.test.js test/cloudinary-isolation.test.js
npm test
```

Readiness and CORS checks:

```bash
curl -i https://<staging-backend-host>/health
curl -i https://<staging-backend-host>/ready
curl -i -H "Origin: https://<staging-frontend-host>" https://<staging-backend-host>/health
curl -i -H "Origin: https://unlisted.example.com" https://<staging-backend-host>/health
```

The first CORS request should include `Access-Control-Allow-Origin` for the staging frontend origin. The unlisted origin should not. CORS headers govern browsers; a request without an `Origin` header is not a browser cross-origin request.

To confirm the production frontend points at staging, build with the staging `VITE_API_URL`, serve `client/dist/`, open the app in a browser and inspect the Network panel. API calls must target the staging backend and must not target `localhost`.

Known server test status:

- Total: 1,296 tests
- Passed: 1,294
- Failed: 2

The two failures are in `server/test/firebase-credential.test.js` and are caused by the previously documented Firebase Admin singleton/test-isolation issue. The complete server suite is **not** fully green.
