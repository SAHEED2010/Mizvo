# ADR-006: Passkeys, independent owner recovery, and recent step-up

- **Status:** Accepted architectural direction (2026-10-15) — implementation and production activation remain subject to the security gates below
- **Date:** 2026-10-15
- **Decision owners:** Mizvo team
- **Depends on:** [ADR-001](001-multi-business-identity-and-access.md), [ADR-002](002-authentication-whatsapp-onboarding-and-recovery.md), [ADR-005](005-business-onboarding-and-active-business.md) (proposed), [ADR-007](007-phone-only-business-invitations.md) (proposed)
- **Workstream:** Build 002 Phase C3a–C3d

## Context

Mizvo uses Better Auth 1.7.7 Phone Number + Organization, Drizzle/PostgreSQL, Next.js and Fastify. Verified phone OTP creates an identity and signs users in; a user can have distinct roles in multiple businesses. Sessions must have an absolute maximum lifetime of seven days. C2 invitation and membership-management HTTP operations remain default-deny until independent owner recovery enrollment and fresh step-up are implemented and reviewed.

Owners may have no deliverable email address, and a temporary Better Auth email in the reserved .invalid domain is **never** a recovery destination or verified email. Mizvo does not yet own a canonical production domain or have approved live OTP delivery. Render's temporary hosting hostname must not silently become the long-lived passkey identity.

## Accepted architectural direction

1. **Identity stays phone-first.** Keep Better Auth as the only user/session authority and the Organization plugin as the only business-membership authority. Add a version-compatible official @better-auth/passkey plugin as an *additional* credential on the existing user ID; do not create or link an account merely because a phone, email, organization name, WhatsApp sender or credential name matches.
2. **Required enrollment for sensitive owners, not for ordinary business access.** An owner may register and create a business with a verified phone. Before privileged membership, recovery, ownership, credential or sensitive-report actions, require an independently enrolled passkey/recovery method and real recent authentication. Staff may enroll optionally. A new passkey on its own does not automatically unlock C2 APIs.
3. **C3a is enrollment foundation only.** In a test-only configuration, allow authenticated, verified-phone test identities to enroll and list passkeys with server-verified WebAuthn ceremonies. Do not activate public enrollment, generic passkey sign-in, unrestricted passkey deletion, recovery or C2 owner actions in C3a. Never rely on UI hiding to block an auth-plugin HTTP endpoint; explicitly gate each browser-exposed passkey endpoint in Fastify.
4. **Enrollment and credential modification are sensitive.** First enrollment into an established phone-only account could be used by an attacker holding a reassigned or compromised SIM. Treat that initial credential as provisional for owner-management privileges until independent recovery enrollment and reviewed anti-takeover safeguards are satisfied. Adding/replacing/deleting credentials on an already enrolled account requires proof using an *existing* trusted passkey or the separately reviewed restricted recovery flow; a new phone OTP alone does not authorize replacing credentials. Prevent loss of the only trusted credential without an approved recovery path.
5. **Emergency recovery codes (later C3b).** Generate high-entropy, one-use codes using vetted cryptographic functions, disclose only during issuance, store only irreversible verification material, rate-limit attempts and atomically consume them. Phone OTP plus one unused recovery code may authorize a **restricted passkey-replacement session**, but not immediate access to invitations, role changes, ownership transfer or sensitive exports. Existing sessions/credentials should be assessed for revocation; send trusted-channel notices where supported. Duration of any hold and the lost-phone-and-passkey scenario require further reviewed policy; recovery code alone must never grant full owner privileges.
6. **Recent authentication (later C3c).** A valid session or Better Auth's generic session-freshness flag is **not** sufficient step-up. Verify a new passkey assertion with a server-generated unpredictable one-time challenge, exact RP ID and origin checks, user verification required, and cryptographic signature verification. Store or derive server-validated proof tied to user, current session, permitted business/action scope and time; expire it after at most **10 minutes**. Check current membership and role at use time, invalidate on credential change, recovery or session revocation. Particularly consequential operations require their own fresh assertion.
7. **C2 activation (later C3d).** Existing C2 owner action guards continue denying by default. Invitation acceptance is for the *authenticated intended recipient* and must not require the recipient to be a business owner; create/revoke/member-role actions require owner authorization, enrolled recovery and valid step-up. No bypass through direct Better Auth Organization or Passkey routes, stale business selection, test fixtures or permissive environment variables.

## WebAuthn relying party and deployment

- **Local development:** Use a fixed, explicit development origin, for example http://localhost:3000 (Next.js browser origin) and RP ID localhost, with matching Better Auth/passkey configuration. Do not mix localhost and 127.0.0.1 as if they were interchangeable WebAuthn origins.
- **Fastify and proxy:** Browser WebAuthn ceremonies occur on the public Next.js origin. Fastify processes and verifies them behind the existing same-origin /api/auth proxy. Verify server-side Origin/Host/proxy trust and cookie scope rather than assuming the Fastify private hostname is the browser RP ID.
- **Production:** Require a reviewed canonical HTTPS origin, stable RP ID, trusted proxy configuration and explicit domain/re-enrollment policy before activating enrollment for real users. No canonical domain has been selected. A temporary *.onrender.com host must not be used as a permanent passkey RP ID without an explicit migration decision.
- **Authenticator policy:** Require user verification for owner-sensitive ceremonies; use the passkey plugin's backed-by-SimpleWebAuthn verification rather than custom signature cryptography. Support platform and cross-device authenticators where suitable, and test actual Android/iOS/Windows devices and in-app browser constraints. Browser/device support is not guaranteed by unit tests.

## Phased implementation and mandatory gates

### C3a — Authenticated passkey enrollment, no owner privilege activation

- Pin a compatible @better-auth/passkey version against existing Better Auth dependencies; validate supported plugin API and its Drizzle table requirements.
- Add passkey schema through the existing Better Auth schema-generation/maintained-fragment workflow, review a committed forward migration and keep the schema-regeneration/migration-drift CI check green.
- Build limited, accessible Next.js UI for *test-only* passkey enrollment/status and list, without revealing synthetic placeholder emails. Do not enable passkey sign-in or deletion until separately reviewed; no production-usable credential management endpoint should be exposed by accident.
- Require an existing authenticated session, verified phone, exact trusted origin and verified WebAuthn response. Never allow pre-auth passkey registration or arbitrary client-selected user IDs. Preserve C1 membership rules, seven-day sessions and C2 default deny.
- Add PostgreSQL integration/negative tests for wrong account, unverified phone, replayed challenge, expired challenge, wrong RP ID/origin, invalid credential, concurrent enrollment, session expiration, HTTP endpoint guard, schema regeneration and rollback. Test real-browser ceremony separately; do not claim a simulated browser proves authenticator compatibility.

### C3b — Recovery codes and restricted lost-passkey recovery

- Independently review code generation/verifier storage, atomic redemption, abuse limits, limited replacement session, notifications/session revocation, credential reassignment and recovery holds.
- No activation until threat model and negative tests are approved.

### C3c — Passkey recent-authentication step-up

- Implement server-validated, session/business/action-bound proof, strict ten-minute freshness, and tests against replay, parallel claims, stolen session, stale authorization and other business IDs.

### C3d — Protected invitation/member actions

- Activate the already-reviewed C2 lifecycle only after real C3 recovery and step-up verifiers are available and audited. Source invitation-acceptance identity from Better Auth session, not JSON. Retest last-owner and tenant invariants end-to-end.

## Mandatory implementation decisions still requiring explicit security review

1. **First enrollment security:** How is an existing owner protected against SIM takeover / new-device enrollment when they do not yet have a passkey? Define a limited privilege state, trust checks and security hold; do not treat OTP as independent proof.
2. **Production RP ID:** What permanent domain will Mizvo use and how will credentials registered against test hosting domains be migrated/re-enrolled?
3. **Recovery hold and lockout:** Specify restricted recovery capabilities, notification/appeal path if feasible, hold duration and safe outcome when both phone and passkey are unavailable.
4. **Credential-management API policy:** Audit the exact plugin endpoint list/version, define allow/deny routes, proof freshness for add/delete, and preservation of the last usable credential.
5. **Persistence:** Decide tables/retention/rotation for challenges, recovery codes, step-up proof and audit metadata. Never log raw OTPs, recovery codes, challenge secrets or private credential material.

## Alternatives considered

- Email as a mandatory recovery factor: rejected; excludes phone-first users and synthetic addresses are invalid.
- Phone OTP alone for sensitive action and passkey replacement: rejected; inadequate independence.
- Passkey registration on an unreviewed temporary Render hostname as public onboarding: rejected pending durable domain strategy.
- A custom passkey cryptographic implementation: rejected in favor of a vetted WebAuthn implementation.

## References

- Better Auth Passkey plugin: https://better-auth.com/docs/plugins/passkey
- Better Auth Drizzle adapter: https://better-auth.com/docs/adapters/drizzle
- W3C Web Authentication Level 3: https://www.w3.org/TR/webauthn-3/

**Approval scope:** The Mizvo project owner approved the architectural direction on 2026-10-15: passkeys, independent emergency recovery codes, restricted phone-OTP-plus-recovery-code recovery, and fresh owner step-up. This does **not** approve implementations of the unresolved first-enrollment controls, recovery hold, WebAuthn domain, credential endpoints or proof persistence. C3a development/test work may begin only within the fail-closed boundaries above; changes affecting production authentication or sensitive owner actions require their own reviewed decisions and verification. This ADR and C3a test code do not authorize real-user registration, live messaging, deployment provisioning, credential recovery activation, owner-sensitive operations or production passkey enrollment.
