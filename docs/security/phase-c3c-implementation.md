# Phase C3c implementation boundary

This records the choices made for Issue #21's isolated development/test verifier. It does not enable a public ceremony, passkey sign-in, recovery, or owner-sensitive operation.

## Test-only verifier

- `@simplewebauthn/server` is pinned directly at `13.3.3`, the version already used by Better Auth `1.7.7`'s passkey plugin. The internal service calls `generateAuthenticationOptions` and `verifyAuthenticationResponse`; it does not call Better Auth's generic authentication routes or create sessions. I audited the pinned plugin's `/passkey/verify-authentication`: after signature verification it updates the counter, creates a session and sets a session cookie, while configuring `requireUserVerification: false`. The Fastify boundary continues to return 404 for this route and its options route; C3c requires verified assertions and does not reuse this login ceremony.
- Construction requires `NODE_ENV=test` and a postgres-js client configured for loopback `127.0.0.1` or `::1` with database `mizvo_test`. Each operation checks `current_database()`. Only explicitly registered `synthetic_fixture` users with verified phone and unverified optional email can start a challenge. A normal verified phone account cannot use the service.
- Local test ceremonies use the fixed origin `http://localhost:3000` and RP ID `localhost`. `localhost` and `127.0.0.1` are not treated as equivalent browser origins.
- Challenges last at most five minutes, permit one credential, and persist a SHA-256 digest rather than the challenge bytes. Failed, mismatched and expired assertions consume their challenge. The service limits challenge issuance to 30 per synthetic user in five minutes under a PostgreSQL advisory lock.
- A valid assertion requires `webauthn.get`, exact origin and RP ID, the pinned same-user credential, signature verification, user verification and the expected challenge. Positive credential counters must advance. Authenticators that report a zero counter remain supported; that counter provides no clone signal.
- Proof rows bind user, live session, business, current owner role, action, SHA-256 target digest, credential fingerprint and counter, test security epoch, issue time and a ten-minute maximum expiry. Each proof can be consumed once. Consumption locks the proof and current authorization/security rows, then rechecks session, membership, credential, counter, epoch and C3b recovery audit activity. Membership insert, removal or role/business change increments the synthetic user's epoch in PostgreSQL. Revoked/deleted sessions and credentials, expired sessions, changed/removed membership, security-epoch changes and new recovery activity fail closed.
- Challenge, proof and audit tables are separate from Better Auth's generated schema. Their IDs and audit fingerprints do not contain assertion responses, challenge bytes, session tokens or private keys. The service is not imported by Fastify or the C2 guard; owner-sensitive requests continue to deny.

## Decisions still open

- How a provisional C3a credential could become eligible for real owner step-up, including initial-enrollment safeguards against phone-number reassignment.
- A canonical production HTTPS origin/RP ID and credential migration or re-enrollment plan.
- Real recovery, recovery hold/lockout, notification and the lost-phone-and-passkey case.
- The public endpoint, CSRF, trusted proxy, UI confirmation, evidence-retention and atomic privileged-action consumption design.
- Physical authenticator and mobile/in-app browser compatibility. Chromium virtual-authenticator tests establish the code path only; they do not establish physical-device compatibility.

No unresolved policy is inferred by this test foundation.
