# Unified user accounts and mobile integration

Migration 017 consolidates Crew and Captain identity and profiles into `users`.

## Schema

`users`: `id` (UUID PK), `auth_subject` (unique Privy DID), `display_name`,
`username` (unique, nullable), `role` (`crew` or `captain`, nullable), `bio`,
`avatar_url`, `banner_url`, `paper_cash` (numeric 38,18), `created_at`.
Username and role must both be null or both populated. Their presence establishes
completed account setup; there is no onboarding timestamp or duplicate profile table.
Role selects the account experience and eligibility to create a new fund. Fund ownership
still controls trading; Captains can hold shares in other funds as Crew. Changing role
does not change historical fund ownership or make historical Captain records disappear.

`funds.captain_id` and `user_asset_uploads.user_id` reference `users.id`.
`fund_shares` remains the per-fund participation table. Wallets and financial records
remain separate. The existing image storage config, buckets and object prefixes are
retained; both roles use them through the shared upload routes.

Migration copies Captain handles, bios and images unchanged, and assigns those users
`role=captain`. Accounts without a Captain profile remain unfinished; device-local
usernames are not imported or assumed globally unique. Legacy usernames starting with
numbers/underscores are preserved. New claims/renames require a starting letter.
Do not modify historical migrations. Back up the local database before applying to an
existing dataset; production deployment needs coordinated API rollout with migration 017.

## API

All protected routes use the current Privy access token as Bearer authorization.

| Method/path | Access | Contract |
| --- | --- | --- |
| POST /v0/auth/privy | Bearer | `{}` bootstraps; `user` contains the full account DTO |
| GET /v0/me | Bearer | Full account DTO |
| GET /v0/users/username-availability?username=... | Public | `{mode,username,available}` |
| POST /v0/me/onboarding | Bearer | `{username,role,displayName?}`; returns account DTO |
| PATCH /v0/me | Bearer | Any of `username,role,displayName,bio,avatarUrl,bannerUrl`; returns account DTO |
| POST /v0/me/assets/uploads | Bearer | `{kind,contentType,byteSize}`; returns signed PUT URL and upload UUID |
| POST /v0/me/assets/uploads/:uploadId/complete | Bearer | Validates/publishes image; returns `asset.url`; attach via PATCH /me |

Account DTO: `{id,displayName,username,role,bio,avatarUrl,bannerUrl,mode:"PAPER",paperCash:{value,asset:"USDC"}}`.
Money remains an exact decimal string. Username: 3–24 lowercase letters/digits/underscores,
starting with a letter. Display name: 1–40 characters, nonblank. Bio: up to 500 characters.
Availability is advisory. Claims and renames rely on SQL uniqueness; conflicts return
`409 username_taken`. Signup is atomic and same-input retries are safe. A second signup
with different username/role returns `409 already_onboarded`; use PATCH /me for edits.
Client-provided identity, balances and approval state are rejected.

Images must be completed uploads owned by the account and of the matching kind.
Completion on the shared path does not attach the image until PATCH /me, so failed
profile edits retain the previous image. Legacy Captain completion paths still attach
images for compatibility. Requests are limited to 20 image uploads/account/hour, 5 MB/file.

Existing `/v0/captains` and Captain profile/upload routes remain compatible aliases over
`users`, with `handle` mapped to `username`. There is no Captain approval workflow.

## Bloom availability

`username_index_state` tracks an instance UUID and revision. Redis keys use the
`usernames` namespace. All claimed usernames are indexed, for both roles. The revision
advances on actual username insertion/change/deletion and truncation. Null-account
bootstrap and balance/profile-only writes do not invalidate readiness.
Synchronized negatives avoid a username lookup; positives always check PostgreSQL.
Stale, missing or unavailable Redis falls back to SQL and lazily rebuilds the filter.
Renamed usernames can temporarily remain Bloom positives but SQL makes them available.

## Local development

From the backend root:

```sh
docker compose up -d postgres redis
pnpm build
pnpm db:migrate
pnpm dev:api
```

These new API/migration commands load the root `.env` automatically. Set `DATABASE_URL`
to local PostgreSQL, `REDIS_URL=redis://127.0.0.1:6379`, `PORT=3000`, and `PRIVY_APP_ID`
to the same app ID used by Expo. Leave `USDG_MINT` unset for the initial PAPER auth flow.
Set `CORS_ORIGINS` to exact Expo web origins, e.g. `http://localhost:8082`.
Browser image uploads additionally require the storage bucket's allowed origins.

In `apk/.env`, set `EXPO_PUBLIC_API_URL=http://127.0.0.1:3000`, the matching public
Privy app ID and the Privy mobile client ID. Keep `EXPO_PUBLIC_AUTH_PREVIEW=false`.
For a connected Android device/emulator run `adb reverse tcp:3000 tcp:3000`.
Real OTP/Google login also requires the corresponding Privy dashboard configuration.

## Validation

Run backend build and typechecks, and all API tests with a local `TEST_DATABASE_URL`
and a dedicated `TEST_REDIS_URL`. Tests create/drop random SQL schemas and isolate
Bloom keys by schema instance UUID. Migration coverage includes existing profiles,
funds and uploads. Runtime checks cover claims, concurrency, retries, rename, authorization,
CORS and Bloom false positives/staleness/fallback. The existing financial/auth/history
regression suites remain required.

App checks: lint, typecheck, `npm run test:account`, `npm run test:auth`, and web export.
Account-store tests cover token failures, bounded 401 replay, restoration, deduplication,
retry, stale responses and logout during bootstrap/profile save. Real device verification
is separate from these locally signed-token simulations.
