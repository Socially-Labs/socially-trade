# Local phone API connectivity

The phone must reach the API's Wi-Fi address, with `HOST=0.0.0.0`, on port 3000.
Use the same origin in the APK's `EXPO_PUBLIC_API_URL`. Restart Metro after an
environment change; localhost on a physical phone refers to that phone.

Check `curl --max-time 5 http://localhost:3000/health` and the same path using
the Mac's Wi-Fi address. `lsof -nP -iTCP:3000 -sTCP:LISTEN` should show one API.
Start it with `pnpm dev:api` or the full `pnpm dev`, avoiding duplicate API watchers.

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
