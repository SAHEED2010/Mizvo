# Phase C3d — test-only protected-action foundation

## Scope and boundary

This implementation adds an internal synthetic-account test harness only. It requires `NODE_ENV=test`, a loopback postgres.js connection to `mizvo_test`, and an existing C3c proof for the exact user, session, business, owner membership, action and target. The harness checks the database identity again before and inside its transaction, consumes the proof in that transaction, then runs the supplied test effect. Effects use the constrained `protected_action_test_effect` table, which accepts only invitation create/revoke metadata for C3c synthetic identities; it does not store invitation tokens, phone numbers or real membership changes. A failed effect rolls back both the effect and proof consumption; replay and concurrent use allow one execution at most.

The harness is not imported by Fastify or the C2 guard. It does not authorize any runtime request. Existing owner-sensitive HTTP routes and Better Auth's unrestricted Organization/Passkey paths remain denied. C3a provisional passkeys and C3b synthetic recovery state remain ineligible for production owner authorization.

## Transaction integration blocker

The existing `createPhoneInvitation` and `revokePhoneInvitation` functions use Better Auth's `runWithTransaction` and its Drizzle adapter transaction. C3c `consumeProof` currently owns a separate postgres.js `client.begin` transaction. Those calls use different transaction managers and the service APIs do not accept the same transaction object. Nesting one operation inside the other therefore cannot guarantee a shared connection, commit or rollback. The C3d harness exposes the C3c proof check to a caller-owned postgres.js transaction for synthetic effects, but it does not call either C2 mutation helper or write invitation/membership state directly.

Do not integrate C3c proof consumption with C2 invitation creation or revocation until the Better Auth adapter and postgres.js work can be proven to share one transaction, with tests demonstrating rollback and contention behavior across both layers. Current owner invitation create/revoke remain blocked by the existing fail-closed HTTP guard.

## Recipient acceptance

The C2 acceptance service remains a separate recipient-only path. PostgreSQL coverage verifies the intended verified-phone user has no membership or owner role before acceptance, that an unverified or mismatched phone cannot accept, and that successful acceptance creates only the invited role. The recipient does not need owner proof. This adds no public acceptance route and does not grant authority over other businesses.

## Deferred decisions

- A transaction API spanning Better Auth Organization membership writes and C3c proof consumption.
- Production trusted passkey/recovery enrollment, proof activation, audit retention and public route/CSRF policy.
- Member removal, role changes and ownership transfer semantics.

These remain separate security-reviewed milestones; no production behavior is inferred here.
