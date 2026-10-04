# Captain handle availability and Redis Bloom index

## Setup

1. Start dependencies: `docker compose up -d postgres redis`.
2. Load `DATABASE_URL` and `REDIS_URL=redis://127.0.0.1:6379` into the API environment.
3. Run database migrations: `pnpm --filter @socially/db migrate` (includes migration 010).
4. Start the API. The Redis filter initializes lazily on availability reads/profile creation.

The Compose service uses Redis 8.2.2, whose standard distribution includes Bloom
commands, with append-only persistence and a local-only port. A managed Redis
service must support `BF.RESERVE`, `BF.ADD`, `BF.MADD`, `BF.EXISTS` and Lua scripts.
A plain older Redis instance without Bloom support will fall back to PostgreSQL.
For production use private Redis connectivity, credentials and TLS (`rediss://`).
The application does not automatically load `.env`; configure actual runtime variables.

## UI contract

```http
GET /v0/captains/handle-availability?handle=jassbawa
```

Anonymous, no idempotency key. Response:

```json
{ "mode": "PAPER", "handle": "jassbawa", "available": true }
```

`Cache-Control: no-store`. Validation: `^[a-z0-9_]{3,24}$`; no extra query fields.
Invalid input returns `400 invalid_request`. Availability does not reserve a handle.
`POST /v0/captains` remains the claim operation and uses the database unique constraint.

## Read flow

1. If Redis is unconfigured, connecting, in cooldown or unavailable, query the
   PostgreSQL unique handle index directly.
2. Otherwise, read the committed database index revision and instance ID.
3. An atomic Redis script verifies that the filter exists and its revision matches
   the database revision before running `BF.EXISTS`.
4. A synchronized negative returns `available: true` without a handle-row lookup.
5. A positive is only a possible match: confirm it with an indexed PostgreSQL lookup.
6. A stale/missing filter falls back to PostgreSQL and starts a background rebuild.

This optimization still performs one small PostgreSQL revision lookup on Redis-enabled
reads. It avoids the per-handle lookup for synchronized negatives; it does not eliminate
all database reads. Concurrent registration can change availability after a check,
so creation always relies on database uniqueness.

## Write flow and recovery

Migration 010 adds a singleton revision and database instance UUID. A PostgreSQL
statement trigger advances the revision transactionally on INSERT, DELETE,
UPDATE OF handle and TRUNCATE of captain_profiles. Normal direct SQL writes are
therefore detected too, provided triggers remain enabled.

Profile creation inserts within a transaction and captures its exact revision.
After commit, Redis adds the handle and advances its readiness revision in one
script **only when** the old revision is the immediate predecessor. An outage or
out-of-order write leaves the filter stale, so subsequent reads use PostgreSQL
until it rebuilds. Redis failures never undo a successful database registration.

Rebuilds use a repeatable-read database snapshot, fetch handles in batches of
1,000, populate a temporary filter and atomically rename/publish it when complete.
A completed older snapshot cannot overwrite a newer published revision. Changes
committed during the rebuild cause a revision mismatch and database fallback;
another lookup starts a fresh rebuild if needed.

Each API process coalesces its rebuild requests. Multiple instances can rebuild
concurrently; complete publication and revision checks preserve correctness, but
cold starts may duplicate rebuild work. There is no distributed rebuild queue.

## Configuration and lifecycle

- Fixed initial capacity: 100,000 handles; Redis Bloom's default scaling grows it.
- Target false-positive probability: 0.001 (0.1%). Positives are confirmed in SQL.
- Published filter and readiness marker expire after 24 hours, refreshed by
  successful incremental additions. Expiration/eviction triggers safe rebuilding.
- Connection/command timeout: one second. Error cooldown/reconnect delay: 30 seconds.
- Rebuild budget: 30 seconds; individual SQL statements: five seconds. If a dataset
  exceeds that budget, reads continue through PostgreSQL; tune or introduce an
  offline builder before relying on acceleration for a much larger dataset.
- Temporary rebuild keys expire after 120 seconds and are deleted after normal completion/failure.
- Keys use a database-instance UUID and a shared Redis hash tag, avoiding accidental
  reuse between separately migrated databases/schemas and keeping scripts in one slot.
- The current client connects to a standalone Redis URL; this does not configure
  an ioredis Cluster client or Sentinel discovery.
- Application close waits for any rebuild and disconnects Redis.

There is no username delete/rename API today. Database changes to handles invalidate
readiness; rebuilds remove obsolete entries. Never manually set a readiness marker.
After restoring a database backup, clear the two published Redis keys for its instance
(or use a fresh isolated Redis database) so the index is rebuilt from the restored data.
Database clones from the same backup must use separate Redis databases or reset
`captain_handle_index_state.instance_id` before sharing Redis.

## Validation recorded

API type checking and the monorepo build passed during implementation. Runtime Redis, SQL trigger and
endpoint simulations have not been run for this feature; no frontend was created.

Sources: [Redis Bloom filter](https://redis.io/docs/latest/develop/data-types/probabilistic/bloom-filter/),
[BF.RESERVE](https://redis.io/docs/latest/commands/bf.reserve/).
