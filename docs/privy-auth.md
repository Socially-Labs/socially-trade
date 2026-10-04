# Privy backend authentication

The client signs in with Privy and sends its access token as a bearer token.
The backend verifies that token and maps its `did:privy:...` subject to the local
PostgreSQL user. Tokens and Privy secrets are not saved in the database.

## Get your Privy configuration

1. Sign in at [Privy Dashboard](https://dashboard.privy.io/) and create or select your app.
2. Open **Configuration → App settings → Basics** and copy the **App ID**.
3. Enable the login methods your client will use, such as email or Google.
4. Configure your client domains/redirects for the intended environment.

You do not need to find or copy a verification key in the dashboard. The backend
resolves public keys from `https://api.privy.io/v1/apps/<app-id>/jwks.json`, as Privy's
official Node SDK does. The app secret shown in the dashboard is not required by
this backend's verification flow. Keep it server-only if configured for future
Privy server API operations. Use separate Privy apps/configuration for
isolated development and production identities if desired.

## Configure the API

Set server environment variables before starting the API:

```dotenv
PRIVY_APP_ID=your-privy-app-id
```

Leave `PRIVY_VERIFICATION_KEY` unset for normal use. The API fetches and caches the
app's public keys for up to one hour, with a 30-second cooldown between key refreshes
and a five-second fetch timeout. It supports key rotation without manually copying
a PEM key. The first verification and subsequent refreshes require network access
to Privy; cached keys verify tokens locally. No app secret is required for
signature verification. Configure actual environment variables through the existing
runtime/deployment environment; copying `.env.example` alone does not load it.
The deployed API must use HTTPS.

An optional `PRIVY_VERIFICATION_KEY` public PEM override is supported for isolated
simulations or explicitly pinned keys. Both real newlines and escaped `\n` are
accepted. An override disables automatic fetching and rotation; remove any placeholder
value from your environment to use the normal JWKS path.

## Bootstrap the backend account

```http
POST /v0/auth/privy
Authorization: Bearer <privy-access-token>
```

No body is required; an empty JSON object is also accepted. Client-supplied user IDs,
email, balances or wallet addresses are rejected.

Response:

```json
{
  "mode": "PAPER",
  "provider": "privy",
  "privyUserId": "did:privy:example",
  "user": {
    "id": "local-user-uuid",
    "displayName": "Trader",
    "paperCash": { "value": "10000.000000000000000000", "asset": "USDC" }
  }
}
```

The existing account transaction creates a user and grants virtual USDC once.
Retries/concurrent requests return the same account without another grant.
Existing users receive their current balance, which may differ from the example.
The endpoint verifies Privy tokens even in development; it never accepts the local
development token as a substitute.

## Use protected endpoints

Send the same Privy access token to `/v0/me`, order
submissions, Crew joins/exits and other authenticated endpoints. The server verifies
it on each request. The bootstrap endpoint does not issue a second API token,
create a cookie session or refresh Privy tokens.

The client should obtain a current token from the Privy SDK. On expiration, refresh
through Privy and retry with the renewed token. Keep an existing idempotency key when
retrying the same financial action.

## Verification and errors

- Signature algorithm restricted to ES256, using the app's public keys.
- Issuer must be `privy.io`; audience must include `PRIVY_APP_ID`.
- Subject, issuer, audience, issued-at and expiry claims are required.
- Expiry/not-before are checked; future issued-at timestamps beyond five seconds reject.
- Subject must be a Privy DID. Development identity headers cannot override it.
- Missing/invalid/expired token: `401 unauthorized`.
- Missing configuration or invalid public-key configuration: `503 auth_unconfigured`.
- Public-key fetch failure or malformed key service response: `503 auth_unavailable`.

Keep server clocks synchronized. Verification does not check remote session
revocation on every request. JWKS keys refresh automatically; if using a PEM
override, rotate the configured public key manually when needed.

## Existing authentication and migration

Privy is the only provider in every environment. Generic JWKS configuration,
provider selection and shared development tokens have been removed. Other
provider tokens are rejected; there is no development identity bypass.

Privy DIDs identify distinct accounts from former development or other-provider
subjects. Existing trial balances/history are not automatically linked or migrated.
Do not link accounts based on a client-supplied email or wallet address.

This integration does not create wallets, sign transactions or call the v1 program.
It requires your actual Privy app configuration for live sign-in validation. The
previous 80-test report predates this integration. The existing simulation fixtures
now sign local ES256 tokens through the production verifier; those changes have
not been run as part of this provider cleanup.

Reference: [Privy access-token documentation](https://docs.privy.io/authentication/user-authentication/access-tokens).
JWKS resolution: [official Privy Node SDK source](https://github.com/privy-io/node-sdk/blob/main/src/lib/auth.ts).
