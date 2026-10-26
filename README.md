# CareerZ backend

Express API with MongoDB/Mongoose. Run `npm install`, configure `.env` from
`.env.example`, then run `npm run dev`. The API defaults to port 5000.

## Database requirements

Wallet transfers, withdrawals and payment settlement use MongoDB transactions.
Use a **replica set or sharded cluster** (including MongoDB Atlas), not a standalone
MongoDB server. `USE_MEMORY_DB=true` now starts a single-node temporary replica set
for local development and automatically seeds it. Its data is lost on restart.
Production requires `USE_MEMORY_DB=false`, a persistent `MONGO_URI`, and configured
JWT/encryption secrets. No unsafe nontransactional fallback is provided.

## Payments

Every online checkout uses JazzCash (Page Redirect): institute fees, courses,
wallet top-ups, featured jobs, institute plans (30 days, renewed by paying again)
and tuition fees. Wallet top-ups can also be paid in crypto via NOWPayments.
Paddle and Stripe checkout were removed; old `paddle*`/`stripe*` fields stay on
the models only so past records remain readable. Stripe is still used for the
optional Stripe Connect salary payout.

A JazzCash checkout first stores a `JazzCashPayment` with our own amount and
purpose. The signed browser return, the IPN and the status-inquiry sync all
verify the secure hash, merchant, currency and exact amount, then settle that
record once inside a transaction. Failures roll back so a later confirmation can
retry. NOWPayments IPNs verify signatures and commit the webhook receipt in the
same transaction; duplicate events return HTTP 200 without applying effects again.
Notifications run after commit and are best-effort; they are not a durable outbox.

Ensure the wallet `(user, currency)`, webhook `(provider, eventId)` and
`JazzCashPayment.txnRefNo` unique indexes exist before accepting payments. If
automatic index creation is disabled, create them through your normal migration
process.

Old webhook receipts created before transactional settlement may already exist
for failed processing. Those historical payments require reconciliation against
gateway records; the new code cannot infer which old receipts represent failures.

Withdrawals still require an administrator to perform the real payout outside
CareerZ. This change makes the reservation and ledger consistent; it does not
introduce a payout gateway. The existing gateway amount conversion uses two
decimal places; broader currency minor-unit support is outside this change.

## Realtime authentication

Socket.IO clients must supply `auth: { accessToken }` with a valid access JWT.
A claimed `userId` is ignored. The server verifies the token and active account,
then joins only that account's room. Connections close when the token expires;
clients must refresh through HTTP and reconnect with the new token. The current
React app uses HTTP for messages and notifications and has no Socket.IO connection
to migrate. Account status is checked on connection, not continuously thereafter.

## Regression checks

Run `npm test` with a supported Node.js version (Node 22+ recommended). Tests create
an isolated temporary MongoDB replica set, verify signatures using test secrets,
and disable notification delivery. They do not use the configured application DB
or call payment providers. `mongodb-memory-server` may download MongoDB on the
first run; set `MONGOMS_SYSTEM_BINARY` to a local `mongod` binary for offline runs.

Coverage includes socket impersonation, concurrent overspending, transfer
rollback, withdrawal reservation/review races, duplicate webhook and sync
delivery, invalid inputs, and successful webhook retry after injected failures.
