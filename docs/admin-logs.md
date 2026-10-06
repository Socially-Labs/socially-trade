# Backend service logs

Open **http://localhost:3000/admin/logs** after building and starting the API. The API
serves the page directly; no separate frontend server or hosted logging service is needed.

The viewer includes live polling every two seconds, pause/resume, refresh, service
and severity filters, time range, full-context search, exact request ID filtering,
expandable structured details, clipboard copy, and JSON export of the latest 250
displayed matches. Times use the browser's local timezone. Filters persist in the
page URL; access tokens do not.

## Collect all three services

Set the **same `REDIS_URL` and `LOG_REDIS_KEY`** for the API, worker and ingestor.
The default key is `socially:admin:logs:v1`. Use different keys for different environments.
Each application executable captures console output and startup/shutdown diagnostics.
The API also captures Fastify's structured request/response/error logs. Successful
worker cycles emit counts when they process work.

```sh
docker compose up -d redis postgres
pnpm install
pnpm build
pnpm dev
```

The services still require their normal database, Jupiter, and RPC configuration.
Set `REDIS_URL=redis://127.0.0.1:6379` in the environment of **each** process (including
the worker). The apps' `dev` and `start` scripts load `backend/.env` when it exists;
explicit environment variables take precedence.
Restart running services after installing this change. Existing terminal history
and infrastructure container logs (PostgreSQL/Redis) are not imported.

## Access

Without `ADMIN_LOGS_TOKEN`, anonymous access to log data is permitted only in
non-production when the client socket is loopback, the Host is localhost/127.0.0.1/::1,
and any Origin matches the backend. Forwarding headers never grant local access.

Set **`ADMIN_LOGS_TOKEN`** to a long random server-only secret to require it in every
environment. Production always requires a configured token. The page prompts for
the token and sends it in the Authorization bearer header. It stays in tab memory;
reload clears it. Serve remote access over HTTPS. Privy end-user tokens do not grant
admin log access. The HTML shell contains no logs and can load without authentication.

Set `ADMIN_LOGS_ENABLED=false` to remove the page and data routes. Access controls
apply equally to JSON reads. Tokens in query parameters are not supported.

## Retention and availability

Redis holds at most **2,000 entries across all services**, with a **24-hour** TTL.
Entries older than 24 hours are excluded from reads even while the buffer remains active.
Each process also holds a bounded local buffer and retry queue. Payloads, strings,
and recursive context depth are capped. This is a recent operational log viewer,
not an archival audit store.

Redis writes are asynchronous and batched. An outage cannot block application jobs
or requests; writes retry from the bounded queue when Redis returns. If Redis is
missing or unavailable, the API shows its own local buffer and clearly reports the
aggregation state. Logs can be lost when buffers fill, a process crashes, or a
shutdown write cannot complete. A fatal startup diagnostic may exist only in the terminal.

Credentials in known sensitive fields, bearer tokens, JWTs, connection URL passwords,
sensitive query parameters, and configured secret environment values are redacted
before collection. Normal terminal logging remains available. Avoid logging secrets
in arbitrary message text; redaction cannot identify every possible secret format.

Service counts/last-log timestamps describe retained activity, **not process health**.
The viewer's requests are silent so polling does not fill its own buffer.

## Verification

```sh
pnpm --filter @socially/logging build
pnpm --filter @socially/api build
pnpm --filter @socially/logging test
node --test apps/api/test/admin-logs.test.mjs
LOG_TEST_REDIS_URL=redis://127.0.0.1:6379 pnpm --filter @socially/logging test
```

The Redis test uses a unique test key and removes it afterward. Without
`LOG_TEST_REDIS_URL`, that integration test is skipped; unit and route tests run
without PostgreSQL or Redis.
