# Developer guide

CareerZ has two repositories:

| Repository | Stack |
| --- | --- |
| Frontend | React 19, Vite, React Router |
| Backend | Node.js, Express, Mongoose, Socket.IO |

## Run locally

Requires Node.js 22 or later.

### Database

Transactions are used for wallets and payments, so MongoDB must be a replica set or a sharded cluster. Choose one:

- **Temporary:** set `USE_MEMORY_DB=true`. A one-node replica set starts and is seeded. Its data is lost on restart.
- **Your own replica set:**
  ```
  mongod --replSet rs0 --dbpath ./data
  mongosh --eval "rs.initiate()"
  ```
  Then set `MONGO_URI=mongodb://127.0.0.1:27017/careerz?replicaSet=rs0` and run `npm run seed` once.
- **MongoDB Atlas:** use a development cluster. Do not point a local `.env` at production.

### Backend

```
npm install
cp .env.example .env
npm run dev
```

The API runs on port 5000. `npm test` runs the suite against a temporary database and never uses `MONGO_URI`.

### Frontend

```
npm install
npm run dev
```

The site runs on port 5173 and calls `http://localhost:5000/api` unless `VITE_API_BASE` is set. `npm run build` builds the site and writes the search-engine pages.

## Environment variables

Never commit real values.

### Backend: core

| Key | Use |
| --- | --- |
| `PORT` | API port, default 5000 |
| `NODE_ENV` | `production` turns on production checks |
| `CLIENT_URL` | Website address, for links and CORS |
| `SERVER_URL` | API address, for callbacks |
| `PUBLIC_SITE_URL` | Public address used in page tags and the sitemap |
| `MONGO_URI` | Database connection |
| `USE_MEMORY_DB` | `true` starts a temporary database |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Token signing secrets |
| `JWT_ACCESS_EXPIRES`, `JWT_REFRESH_EXPIRES` | Token lifetimes |
| `ENCRYPTION_KEY` | Encrypts sensitive fields such as CNIC numbers. Keep it safe: changing it makes saved values unreadable |
| `TRUST_PROXY_HOPS` | Proxies in front of the API |
| `CRON_SECRET` | Protects internal scheduled endpoints |

### Backend: email and files

| Key | Use |
| --- | --- |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Outgoing email. Blank logs email to the console |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Uploaded images and files |
| `VERIFICATION_MAX_IMAGE_MB`, `VERIFICATION_MAX_PDF_MB` | Verification file limits |
| `VERIFICATION_REQUIRED_FROM` | Accounts created after this date must be verified |
| `BACKUP_MAX_FILE_MB`, `BACKUP_MAX_TOTAL_MB` | Backup limits |
| `GUEST_RETENTION_DAYS` | How long guest job applications are kept |

### Backend: payments

| Key | Use |
| --- | --- |
| `ONLINE_PAYMENTS_ENABLED` | Turns gateway checkout on. Bank-transfer payments work without it |
| `JAZZCASH_MERCHANT_ID`, `JAZZCASH_PASSWORD`, `JAZZCASH_INTEGRITY_SALT` | JazzCash credentials |
| `JAZZCASH_ENVIRONMENT`, `JAZZCASH_RETURN_URL`, `JAZZCASH_DEBUG` | JazzCash mode, return address and logging |
| `SAFEPAY_API_KEY`, `SAFEPAY_SECRET_KEY`, `SAFEPAY_ENVIRONMENT`, `SAFEPAY_RETURN_BASE` | Safepay |
| `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET` | Crypto wallet top-ups |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | Optional salary payouts only |

### Backend: sign-in

| Key | Use |
| --- | --- |
| `OAUTH_SERVER_URL` | Address used for social sign-in callbacks |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google |
| `FACEBOOK_CLIENT_ID`, `FACEBOOK_CLIENT_SECRET`, `FACEBOOK_GRAPH_VERSION` | Facebook |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID` | Microsoft |
| `APPLE_CLIENT_ID`, `APPLE_CLIENT_SECRET`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` | Apple |

The login page shows only the providers that are configured.

### Backend: other services

| Key | Use |
| --- | --- |
| `TRANSLATION_PROVIDER`, `TRANSLATION_WEB`, `MYMEMORY_EMAIL`, `LIBRETRANSLATE_URL`, `LIBRETRANSLATE_API_KEY`, `GOOGLE_TRANSLATE_API_KEY` | Site translation |
| `RTC_STUN_URL`, `RTC_TURN_URLS`, `RTC_TURN_SHARED_SECRET`, `RTC_TURN_USERNAME`, `RTC_TURN_CREDENTIAL` | Live class video across restrictive networks |
| `SITE_ASSISTANT_PROVIDER`, `SITE_ASSISTANT_MODEL`, `SITE_ASSISTANT_API_KEY` | The public Ask CareerZ assistant |
| `AI_SEED_OPENAI_KEY`, `LOCAL_AI_ALLOW_PRIVATE` | Development AI settings |
| `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT` and its private key | Browser push notifications |
| `INDEXNOW_KEY`, `INDEXNOW_DISABLED` | Tell search engines about new pages |
| `SEO_TEMPLATE_PATH` | The app shell used for search-engine pages |
| `DISABLE_FEE_AUTOMATION`, `FEE_AUTOMATION_INTERVAL_MINUTES` | Automatic fee cycles |
| `DISABLE_SUBSCRIPTION_LIMITS` | Turns off plan limits |

### Frontend

| Key | Use |
| --- | --- |
| `VITE_API_BASE` | API address for local work. On careerz.pk the API is same-origin |
| `VITE_PUBLIC_SITE_URL` | Public address used in page tags |

## API

The base path is `/api`.

### Authentication

`POST /api/auth/login` returns `accessToken` and `refreshToken`. Send `Authorization: Bearer <accessToken>`. When a request returns 401, call the refresh endpoint and retry.

`protect` also applies the account gate: an account that is not approved, or whose profile is incomplete, can reach only the onboarding and basic account routes.

### Responses

Success:

```json
{ "success": true, "message": "OK", "data": {} }
```

Error:

```json
{ "success": false, "message": "Course not found.", "errors": null }
```

Payment webhooks reply in the format each provider requires.

### Status codes

| Code | Meaning |
| --- | --- |
| 400 | Bad request |
| 401 | Not signed in, or token expired |
| 402 | Payment needed, such as a blocking fee |
| 403 | Not allowed |
| 404 | Not found, or not visible to this user |
| 409 | The current state does not allow it, such as already decided |
| 422 | A value is not valid |
| 429 | Too many requests |
| 503 | A module is off, or the service is not configured |

### Main route groups

| Path | Area |
| --- | --- |
| `/auth`, `/onboarding`, `/users`, `/roles` | Accounts and verification |
| `/institutions`, `/institution-ops`, `/institution-fees`, `/institution-applications` | Institutes |
| `/courses`, `/learning`, `/live-classes`, `/question-bank` | Learning |
| `/students`, `/teachers`, `/parents`, `/ptm` | People |
| `/jobs`, `/recruitment`, `/employer-*`, `/commissions` | Hiring |
| `/marketplace`, `/freelance` | Marketplace and Freelancer Hub |
| `/wallet`, `/manual-payments`, `/payments`, `/receipts`, `/commission-rules` | Money |
| `/scholarships`, `/funding-requests` | Funding |
| `/admin`, `/admin-ops`, `/admin/moderation`, `/plugins`, `/ads`, `/site-content` | Administration |
| `/public`, `/seo` | Public data and search-engine pages |

Each route file is in `src/routes`, and its handlers are in `src/controllers` and `src/services`.

### Freelancer Hub

| Method and path | Use |
| --- | --- |
| `GET /freelance/services`, `GET /freelance/services/:id` | Public catalogue |
| `POST /freelance/services`, `PATCH /freelance/services/:id` | Create or edit a service |
| `POST /freelance/services/:id/order` | Order a package |
| `POST /freelance/jobs/:jobId/proposals` | Send a proposal |
| `POST /freelance/proposals/:id/decision` | Accept or decline |
| `POST /freelance/orders/:id/milestones/:mId/submit` | Deliver |
| `POST /freelance/orders/:id/milestones/:mId/approve` | Approve and pay the wallet |
| `POST /freelance/orders/:id/milestones/:mId/dispute` | Open a dispute |
| `POST /freelance/admin/disputes/:id` | Admin decision |

A milestone is paid through `POST /manual-payments/freelance_milestone/:milestoneId`.

## How the code is organised

### Frontend

- `src/App.jsx` holds the routes, and pages load on demand.
- `src/allStyles.js` loads every stylesheet up front in a fixed order. Later rules override earlier ones, so do not change the order or import a new stylesheet only from a page. Add it to this file, above `dark-fixes.css`.
- `src/pages/Dashboard.jsx` holds the role workspaces. Newer features live in `src/components/<area>`.
- The open dashboard tab is in the address (`?ws=&tab=`). Use `useUrlTab` for inner tabs, so refresh and the browser's back button work.
- Dark mode is `data-theme="dark"` on the root. Fixes go in `src/styles/dark-fixes.css`.

### Backend

`routes` → `controllers` → `services` → `models`. Put new business logic in a service. Older controllers still hold logic and database calls directly.

## Tests

`npm test` in each repository. Backend tests use a temporary replica set and do not call payment providers.

## Deploy

A push to `main` runs the GitHub Actions workflow in `.github/workflows/deploy.yml`. The backend runs all tests first, then deploys over SSH and restarts with pm2. The frontend builds and publishes the site.

nginx serves the built site, sends `/api` to the backend, and sends job, course and institute detail pages to `/api/seo/render`.

## Restore a backup

1. Stop the backend, or turn on maintenance mode.
2. Take a fresh copy of the current database first.
3. Restore the downloaded backup with `mongorestore` to a test database and check it.
4. Restore to production only when the check passes, then restart the backend.
