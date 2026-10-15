# ADR-007: Guarded phone-only business invitations

- **Status:** Proposed for Build 002 Phase C2
- **Date:** 2026-10-15
- **Decision owners:** Mizvo team
- **Depends on:** [ADR-001](001-multi-business-identity-and-access.md), [ADR-002](002-authentication-whatsapp-onboarding-and-recovery.md), [ADR-005](005-business-onboarding-and-active-business.md)

## Context

ADR-002 requires a custom invitation path for phone-only identities. Better Auth's existing `invitation` table requires email, and its Organization HTTP endpoints remain blocked during C1/C2. C3 recovery enrollment and fresh step-up proof do not yet exist. C2 needs a reviewable invitation lifecycle foundation while keeping owner-sensitive actions unavailable at the API boundary.

## Proposal

1. Keep Better Auth's `invitation` model for real verified-email invitations. Store phone invitations separately in `phone_invitation`; never use `@users.invalid` or another synthetic email.
2. Store an HMAC of the normalized `+234` recipient phone, a SHA-256 hash of a random 256-bit token, organization, inviter, one role (`manager`, `staff`, or `viewer`), lifecycle state, 48-hour expiry, and accepted/revoked actor timestamps. Do not persist the bearer token or raw recipient phone.
3. Record invitation creation, revocation and acceptance in an append-only, business-scoped audit table. Audit rows contain actor, invitation, role and accepted user IDs, never phone numbers or tokens.
4. Internal lifecycle operations authorize the inviter against an owner membership in the specific organization. Acceptance re-reads the recipient's phone and verified state from PostgreSQL, compares the recipient HMAC, claims a pending/unexpired invitation with a conditional update inside a Better Auth adapter transaction, adds membership using the Organization plugin's server-side API, and records the audit event in the same transaction.
5. A central owner-sensitive-action guard requires both server-verified independent recovery enrollment and step-up proof no older than ten minutes. Until C3 provides those proof sources, both fail closed. No environment flag or API option can enable the actions. C2 HTTP create/revoke/accept/member-change/transfer routes stay denied; domain tests may call internal lifecycle functions directly.
6. The signed-in UI explains that staff invitations will be available after recovery and step-up setup. C2 sends no SMS, WhatsApp or email invitation messages.

## Consequences

- Better Auth remains the canonical membership source, and invitation acceptance is atomic with its membership and audit records.
- Database constraints reject owner invitations, invalid roles/statuses, malformed hashes and inconsistent lifecycle timestamps. Conditional state changes and the member uniqueness constraint prevent replay and parallel duplicate grants.
- C2 does not enable user-facing invitations, role changes, removals, ownership transfer, email invitations or external delivery.

## Unresolved choices

- Phone lookup HMAC uses a domain-separated message keyed by the server's Better Auth secret; key rotation and revoked/expired invitation and audit retention periods remain to be decided before production activation.
- A delivery provider, notification content and production rate limits remain unapproved.
- C3 must finalize recovery enrollment storage and recent-auth proof validation. Proposed ADRs remain non-binding until explicitly approved.

## Alternatives considered

- Reusing Better Auth's email invitation table with a placeholder address: rejected because phone-only identities must not use synthetic emails as deliverable or membership evidence.
- Exposing Organization plugin HTTP endpoints or activating C2 routes before C3: rejected because owner-sensitive operations require independent recovery and recent step-up.
- Writing memberships to a new table: rejected because Better Auth Organization is the accepted canonical membership authority.
