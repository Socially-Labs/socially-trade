# Privy backend authentication

The client signs in with Privy and sends its access token as a bearer token.
The backend verifies that token and maps its `did:privy:...` subject to the local
PostgreSQL user. Tokens and Privy secrets are not saved in the database.

## Configure the API

Set server environment variables before starting the API:

```dotenv
AUTH_PROVIDER=privy
PRIVY_APP_ID=your-privy-app-id
PRIVY_VERIFICATION_KEY="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
```

Copy the public verification key for your app from the Privy dashboard.
Both real newlines and escaped `\n` are accepted. No app secret is required for
signature verification. Configure actual environment variables through the existing
runtime/deployment environment; copying `.env.example` alone does not load it.
The deployed API must use HTTPS.

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

When `AUTH_PROVIDER=privy`, send the same Privy access token to `/v0/me`, order
submissions, Crew joins/exits and other authenticated endpoints. The server verifies
it on each request. The bootstrap endpoint does not issue a second API token,
create a cookie session or refresh Privy tokens.

The client should obtain a current token from the Privy SDK. On expiration, refresh
through Privy and retry with the renewed token. Keep an existing idempotency key when
retrying the same financial action.

## Verification and errors

- Signature algorithm restricted to ES256, using the configured public key.
- Issuer must be `privy.io`; audience must include `PRIVY_APP_ID`.
- Subject, issuer, audience, issued-at and expiry claims are required.
- Expiry/not-before are checked; future issued-at timestamps beyond five seconds reject.
- Subject must be a Privy DID. Development identity headers cannot override it.
- Missing/invalid/expired token: `401 unauthorized`.
- Missing configuration or invalid public-key configuration: `503 auth_unconfigured`.

Keep server clocks synchronized. Verification is local and does not check remote
session revocation on every request. Rotate the configured public key when Privy
rotates your verification key and restart/reconfigure the service as needed.

## Existing authentication and migration

With `AUTH_PROVIDER` unset or set to `jwt`, generic `AUTH_JWKS_URL`, `AUTH_ISSUER`
and `AUTH_AUDIENCE` verification remains available. Development-token authentication
is still disabled in production. The generic configuration is not a fallback for
failed Privy token verification.

Privy DIDs identify distinct accounts from former development or other-provider
subjects. Existing trial balances/history are not automatically linked or migrated.
Do not link accounts based on a client-supplied email or wallet address.

This integration does not create wallets, sign transactions or call the v1 program.
It requires your actual Privy app configuration for live sign-in validation. The
existing 80-test report predates this integration and is not evidence of Privy verification.

Reference: [Privy access-token documentation](https://docs.privy.io/authentication/user-authentication/access-tokens).
