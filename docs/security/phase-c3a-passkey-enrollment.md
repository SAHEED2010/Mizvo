# Phase C3a passkey enrollment boundary

Phase C3a adds a local development/test registration path for a passkey on an
existing verified phone identity. It does not enable passkey login, recovery,
step-up authorization, owner-sensitive operations, or production enrollment.

## Runtime gates

The Fastify boundary enables registration and passkey status only when all of
these server conditions hold:

- `NODE_ENV=development`;
- `MIZVO_PASSKEY_ENROLLMENT=development`;
- Better Auth's configured trusted origins contain exactly
  `http://localhost:3000`.

The browser ceremony is fixed to origin `http://localhost:3000` and RP ID
`localhost`. Better Auth still serves through the existing API rewrite to
`127.0.0.1:4000`; its passkey origin is explicitly configured and does not
derive from that API host. The web control also requires a development build,
`NEXT_PUBLIC_MIZVO_PASSKEY_ENROLLMENT=development`, and the exact localhost
origin. Both variables are opt-in and absent from the environment example.
Production Fastify requests return 404 for all plugin passkey paths even if the
development feature flag is mistakenly set.

These development flags are not a public deployment mode. Keep the API bound
to loopback for local testing, and never set both flags on a publicly reachable
development instance; the exact localhost browser origin is not a substitute
for a network boundary.

## Plugin route audit and allowlist

The pinned `@better-auth/passkey@1.7.7` dependency has the same peer version as
the repository's Better Auth 1.7.7 packages. The [pinned plugin source](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/passkey/src/index.ts)
registers seven endpoints. The Fastify allowlist permits only:

| Method and endpoint | C3a behavior |
| --- | --- |
| `GET /api/auth/passkey/generate-register-options` | Development only; authenticated, fresh, verified-phone session |
| `POST /api/auth/passkey/verify-registration` | Development only; authenticated, fresh, verified-phone session; exact local Origin |
| `GET /api/auth/passkey/generate-authenticate-options` | Denied |
| `POST /api/auth/passkey/verify-authentication` | Denied |
| `GET /api/auth/passkey/list-user-passkeys` | Denied; status uses a Mizvo-owned endpoint returning only ID, label, and creation time |
| `POST /api/auth/passkey/delete-passkey` | Denied |
| `POST /api/auth/passkey/update-passkey` | Denied |

Unknown and future passkey plugin paths are denied by default. Registration
requests cannot select `userId`, `context`, or `createSession`. The plugin's
registration callback rechecks the session user, existing verified phone state,
and the cryptographic user-verification result before allowing persistence.
Although the plugin asks the verifier to set `requireUserVerification: false`,
the callback rejects unless its verified result has `userVerified === true`.
Challenge generation uses Better Auth's random 32-character token, signed
HttpOnly challenge cookie, one-use verification storage and five-minute expiry.
The library validates the WebAuthn challenge, RP ID, origin, attestation and
user-presence flags; no custom cryptography is used. PostgreSQL enforces unique
credential IDs to close concurrent registration races.

The first credential remains provisional. It cannot be used to authenticate or
authorize owner operations because the authentication endpoints and all C2
owner-sensitive routes remain blocked. SMS verification alone therefore does
not confer a new privileged action in this stage. A production RP domain and
first-enrollment assurance policy remain unresolved and require a later review.

## Validation boundary

The PostgreSQL security integration suite uses a fake SMS transport and a
Chromium virtual authenticator to complete the local WebAuthn ceremony. It
checks that the new passkey references the same verified user ID, creates no
second user or session, and changes no membership. The authenticator is a
browser simulator; physical keys, platform authenticators, live SMS delivery,
public hosts and production enrollment are not exercised.
