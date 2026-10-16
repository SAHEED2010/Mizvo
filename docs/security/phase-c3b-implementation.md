# Phase C3b development/test recovery foundation

**Status:** Internal synthetic-account test foundation only. This does not activate account recovery.

## Boundaries implemented

- The recovery service is a test-only module and is not imported by Fastify, Better Auth, the website, passkey routes or business handlers. It refuses construction unless `NODE_ENV=test`.
- Synthetic fixtures must be existing Better Auth users with a verified phone, an explicit row in the test-only `recovery_test_identity` registry and a fake OTP receipt verified by the test harness. The registry designation is the synthetic-account signal; `@users.invalid` is a normal phone-first placeholder and is never treated as proof of synthetic identity.
- The service rejects construction unless its PostgreSQL client is configured for the literal loopback host `127.0.0.1` or `::1` and database `mizvo_test`. It also checks `current_database()` inside every transactional or read operation before recovery data access. This boundary is test-only and no account can issue a set from a phone number or OTP alone through a public flow because no route or production caller exists.
- Each internal test code is 256 random bits, encoded as a 43-character base64url value. PostgreSQL stores only a domain-separated HMAC-SHA-256 verifier with its key version. The test key is injected separately from Better Auth secrets and must contain at least 32 bytes. Missing or mismatched keys fail closed.
- A code set has an account-scoped epoch. A new synthetic test set revokes earlier unused codes and outstanding capabilities. Code use is serialized per user and redeemed with a conditional PostgreSQL update in the same transaction as the attempt, restricted state and redacted audit event.
- Rate limits are mandatory explicit constructor inputs in tests. No live account or IP threshold has been selected. Attempt IDs cannot be replayed; a valid code can be consumed once.
- The resulting persisted capability is bound to one user, one attempt, the `synthetic_test` purpose, an explicit expiry supplied by the test and the `recovery_state_only` scope. Its verifier token is returned only to internal tests; no HTTP or runtime consumer accepts it. It cannot authenticate a Better Auth session, serve as passkey assertion or step-up proof, or authorize business permissions. Its state can be inspected and atomically consumed only by the test service.
- No HTTP issuance, redemption, replacement, passkey sign-in/delete, C2 invitation or owner-sensitive action is enabled. The current Fastify guards continue to deny these paths. The test suite exercises the denial boundary with production mode and a mistaken development flag.

## Unresolved decisions remain activation gates

This foundation deliberately does not select policy for real accounts. Review is still required for:

1. Trusted first issuance for existing owners, including SIM-swap and provisional-passkey risks.
2. User-facing code count/format, offline storage and one-time display behavior.
3. Managed verifier-key rotation, retention of old key versions and safe recovery from a lost key.
4. Production rate limits across account, IP and device, monitoring and lockout behavior.
5. Restricted capability lifetime (including the proposed 15-minute maximum) and any eventual allowlisted replacement operation.
6. Recovery hold, notification/contest handling, pre-recovery session and credential revocation, and replacement-code issue timing.
7. The outcome when all factors are lost; no automatic support override is provided.

The synthetic test parameters are not production defaults. C3b must remain disconnected from live accounts until each required policy and activation gate has a separate review and approval.
