# Local phone API connectivity

The phone must reach the API's Wi-Fi address, with `HOST=0.0.0.0`, on port 3000.
Use the same origin in the APK's `EXPO_PUBLIC_API_URL`. Restart Metro after an
environment change; localhost on a physical phone refers to that phone.

Check `curl --max-time 5 http://localhost:3000/health` and the same path using
the Mac's Wi-Fi address. `lsof -nP -iTCP:3000 -sTCP:LISTEN` should show one API.
Start it with `pnpm dev:api` or the full `pnpm dev`, avoiding duplicate API watchers.
If a second watcher reports `EADDRINUSE`, identify the existing listener and its
parent before stopping the duplicate. Changing the API port also requires changing
the phone's configured origin; it does not resolve duplicate ingestion processes.

For a Captain market screen stuck loading, check the public endpoint separately:
`GET /v1/markets?feed=toptraded&interval=24h&limit=50`. It does not require a session.
A failed private vault/watchlist request must not block this catalog. The client
also isolates stream-subscription failures from HTTP discovery and always releases
the polling lock when a polling cycle finishes or is cancelled.

The Jupiter scheduler's `quota_wait` means a request is deferred, including normal
organisation-wide pacing between requests. It does not necessarily mean the minute
quota was exhausted. The client waits for short pacing delays within its request
deadline; the ingestor schedules longer deferrals without incrementing provider
failure counts or invalidating the last marks. Existing marks still age normally
and genuine provider failures still follow the failure/backoff path.

Two recurring failures were fixed:

- Watch reload could leave an old API child draining suspended phone WebSockets,
  with established sockets but no listening port. WebSockets now terminate in
  `preClose`; shutdown has a ten-second deadline so a stuck cleanup hook cannot
  prevent the watcher starting its replacement. Durable operations reconcile
  after restart. Successful cleanup exits explicitly to release auxiliary handles.
- Valid Helius RPC URLs use query authentication. The swap configuration now
  preserves RPC queries while still requiring HTTPS, rejecting embedded user
  credentials/fragments, and verifying the devnet cluster. Venue URLs still reject
  queries. Never paste authenticated RPC URLs into logs or public bug reports.

The client retries a transient connection failure for account bootstrap and the
account read once, within its existing timeout. Financial requests do not opt into
this retry. Persistent Wi-Fi changes, a stopped API, or provider outages can still
cause connectivity errors; a hosted HTTPS API is needed to remove the dependency
on the development machine's Wi-Fi address and running watcher.
