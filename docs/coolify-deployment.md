# Coolify deployment

Deploy `compose.coolify.yaml` from the repository root. It runs the API,
worker, ingestor, PostgreSQL 17, and Redis 8.2. PostgreSQL and Redis use named
volumes and have no published host ports. Keep these volumes when redeploying.

Set the custom start command to `sh scripts/start-coolify.sh <application-uuid>`
to retain API startup errors in the deployment log if Compose startup fails.

Set these runtime environment variables in Coolify:

```text
POSTGRES_PASSWORD=<unique random password>
DATABASE_URL=postgres://socially:<same password>@postgres:5432/socially_trade
REDIS_URL=redis://redis:6379
HOST=0.0.0.0
PORT=3000
NODE_ENV=production
SWAP_ENABLED=true
```

`SWAP_ENABLED=true` requires a working devnet `SOLANA_RPC_URL`; use `false`
to disable swaps. Keep Privy, Jupiter, S3, and other provider configuration
in Coolify environment variables. Refer to `.env.example` for feature flags.
Store `ADMIN_LOGS_TOKEN` as a server-only random secret to access diagnostics.

The API waits for both datastores, then applies pending SQL migrations before
listening. Worker and ingestor start after API liveness confirms migrations
are complete. Native clients do not need browser CORS origins.
Set `CORS_ORIGINS` and `WS_ALLOWED_ORIGINS` to the actual hosted web origins
when serving the web client.

Configure the `api` service domain as `https://api.socially.trade:3000` in
Coolify. The port tells its proxy which internal port to use; clients access
`https://api.socially.trade` on normal HTTPS port 443. Point the DNS `api` A
record at the Coolify server's public IPv4 address. Coolify can then issue
the TLS certificate. PostgreSQL, Redis, worker, and ingestor need no domains.

Check `/live` for API liveness and `/ready` for PostgreSQL, Redis, and fresh
worker/ingestor heartbeats. A successful image build alone does not prove
the application is ready. Protect `/admin/logs` and
`/admin/paper-trading/health` with the admin token.

This stack creates an empty database on its first successful deployment.
It does not copy local accounts, balances, or demo fixtures. Configure
database backups before retaining important hosted data.
