# Phase C3b — Emergency recovery codes and restricted recovery: security design for review

- **Status:** Proposed for security review, **not** a decision to activate recovery or start C3b coding
- **Date:** 2026-10-15
- **Architecture:** [ADR-006](../decisions/006-passkeys-recovery-and-step-up.md) — accepted direction with binding implementation/activation gates
- **Prior foundation:** C3a merged PR #16; local-only test WebAuthn enrollment, no public passkey login or sensitive owner actions
- **Parent work:** Build 002 Phase C issue #8

## Objective and non-goals

Provide a code-based **independent** account recovery mechanism for an existing verified phone-first Better Auth identity, without treating phone-number control or a new credential as sufficient authorization for sensitive owner actions. The recovery code mechanism and restricted-session service must be proven with isolated PostgreSQL integration tests and remain disabled for real users at the C3b development milestone.

This is **not** authorization for live phone OTP, public lost-passkey recovery, phone-number transfer, email fallback, manual support override, owner invitation activation, business ownership transfer, passkey-only login, production deployment or bypassing ten-minute step-up. C3c provides approved fresh passkey-assertion proof; C3d separately activates protected owner actions.

## Threat model

| Adversarial scenario | Mandatory defense |
| --- | --- |
| SIM swap, number reassignment, intercepted SMS, or an OTP-authenticated stolen session | Fresh OTP alone cannot generate/rotate a **trusted** recovery set, clear holds, replace credentials, or turn a newly enrolled provisional passkey into owner-level proof |
| Stolen PostgreSQL dump | Database contains only verification material for unguessable high-entropy codes, not the plaintext codes; the separate server secret stays outside the database |
| Recovery code exposed in logs, analytics, URL, HTTP referrer, telemetry or repeated fetch | One-time output only; never log or put secrets in GET URLs, webhook payloads or generic error details; no re-display endpoint |
| Brute force and account enumeration | Account/IP/device abuse limits, low and consistent public error detail, monitored throttling; avoid leaking whether an account/code exists |
| Two parallel redeemers or a replayed code | Atomic consume in PostgreSQL; only one transaction succeeds; one-time restricted grant is also replay-safe |
| Recovery session or old session used as an owner step-up | Dedicated server-validated recovery capability and allowlist; **not** a normal Better Auth session and not a passkey assertion; guard denies every business-sensitive operation |
| Multiple businesses under same identity | Recovery evidence is account-scoped; it cannot select, create, delete or elevate roles in any business; always re-check current membership in business APIs |
| Recovery started from a compromised account | Notify on trusted preexisting channels when available, audit safely, rotate/revoke exposed credentials/sessions according to reviewed policy; do not rely on a recently altered recovery destination |
| Owner loses phone and passkey, or no safe notification destination exists | No automatic support override or fallback to synthetic *.invalid email; halt and require separately designed high-assurance recovery |
| Mistaken deployment of dev flags | Production Fastify and Better Auth passkey routes stay fail-closed; test-only access must be isolated from public hosts |

## Proposed code generation and lifecycle

- Prefer a small **set** (proposed: eight) of randomly generated codes per enrolled account. Generate each using an approved CSPRNG with **at least 128 bits of entropy** (stronger than NIST's at-least-64-bit saved-recovery-code baseline); encode as readable, copyable ASCII segments with unambiguous characters. Never use a six-digit OTP as a saved emergency code.
- Disclose the complete set **only once during enrollment**, in the user's current secure first-party session; offer accessible copy/print instructions to store offline. Set \`Cache-Control: no-store\`, disable client persistence and keep codes out of URL/query strings, logs, console, error tracing and analytics.
- Store per-code identifier, canonical user ID, verification digest, issuance batch/epoch, timestamps and redemption state. Prefer a domain-separated \`HMAC-SHA-256\` verifier using a **dedicated, managed server-side pepper** with a key/version ID so future rotations are planned. Treat secret provisioning and key rotation as mandatory review gates; fail closed if secret is absent. Do not reuse \`BETTER_AUTH_SECRET\` by default. A robust vetted password hashing approach is an alternative only if the threat/entropy model is revisited. Hashing alone does not solve an attacker-controlled **issuance** flow.
- Use Drizzle PostgreSQL migration with account ID foreign key, uniqueness constraints and transactional issuance/consume; no changes to Better Auth canonical identity, Organization membership or C2 invitation tables. Append-only audit logs record metadata/event outcome **not plaintext codes, raw OTPs or recovery bearer proof**.
- One code succeeds **once** using a single atomic update/transaction and only in a verified, authenticated account recovery ceremony. A successful recovery redemption invalidates the code immediately, no matter whether the replacement flow later completes. Avoid a code becoming valid again after a failed downstream transaction.
- Replenishment/rotation is itself highly sensitive; do not grant code reissue from phone OTP alone, or simply by showing a provisional C3a passkey. Require a separately reviewed trusted prior passkey assertion or restricted-recovery completion with safeguards. After redeeming a saved code, require a replacement-code workflow once trust is restored; do not expose new codes during untrusted recovery.
- Existing valid codes from a prior batch must have an explicit rotation/invalidation policy; do not silently rotate all codes during routine login, and do not assume user saves codes.

## Proposed recovery state machine

1. **Not enrolled:** No code exists. Full recovery/membership controls remain denied. C3a existing passkey may be provisional.
2. **Provisioning pending security approval:** Trusted initial issuance, especially for phone-only owner accounts, is **not yet defined**. Permit synthetic-account, internal/service-level tests only until SIM-takeover-resistant enrollment policy is approved. A newly issued set does not by itself mark an owner as fully protected.
3. **Enrolled and trusted (future gate):** Owner retains independent recovery evidence, with enrollment provenance and audit timestamp. Requires reviewed assurance policy and may not be established by OTP plus a just-created provisional passkey.
4. **Restricted recovery granted (future, test-only initially):** Current verified phone OTP *and* a previously issued unused recovery code bound to **the same Better Auth user** may yield a short-lived, one-time, server-tracked recovery capability. This is **not** an authenticated general session or ten-minute owner step-up. The allowlist is limited to reading recovery status and starting an explicitly reviewed replacement-passkey ceremony when that exists; all business reads/writes and membership APIs remain out of scope for this recovery capability. Do not mint/reuse a normal Better Auth browser session from the recovery capability.
5. **Replacement pending (future integration):** Bind passkey replacement to the restricted recovery capability and exact account, enforce single-use challenge/origin/RP/user verification and proposed hold/revocation safeguards. **C3b must not activate replacement via the C3a generic registration endpoint.** Re-enrollment path needs distinct review.
6. **Restored after security hold (future approval):** The restriction lifts only after the reviewed hold/notification and independent verified passkey assertions; C3c independently verifies real step-up. Old stolen sessions or superseded credentials cannot survive unsafely.
7. **Factors unavailable:** If phone, saved code or suitable authenticator is missing, there is no automatic recovery. Record a safe generic response and defer to a separately approved high-assurance manual/identity-proofing policy, if developed.

## Proposed restricted capability implementation

- Recovery proof is tied to the existing user, recovery attempt ID, security epoch, intended replacement purpose and expiration; expires absolutely (proposed maximum **15 minutes**, pending review). Store only a hash of its bearer secret; rotate/revoke it after use or security change and prohibit refresh.
- Distinguish *pre-recovery* ordinary phone-authenticated sessions from *restricted recovery* capabilities; a valid OTP login must not be promoted to owner-sensitive permissions by this service.
- Recovery capability must never be accepted by C2 owner-sensitive route guards, Better Auth Organization plugin endpoints, financial data reads, exports, role changes, invites, passkey sign-in, passkey delete/rename or other account changes.
- Explicit owner recovery flags/epochs must be checked server-side at every sensitive action; credentials/roles in other businesses do not change as a side effect.
- Audit issuance, invalid attempts (without secrets), successful consumption, restricted recovery, requested replacement, lock/revoke and restored-status transitions. Restrict audit visibility.
- Notify through **already verified independent channels** where actually supported. Live SMS/WhatsApp/email have not been approved. In local tests, capture a fake notification event; do not claim actual delivery or fall back to \`@users.invalid\`.

## Explicit questions requiring security/owner approval before real implementation/activation

1. **Initial issuance:** What evidence beyond control of a potentially swapped phone number is acceptable for an owner without an existing trusted passkey? Should all new owner credentials/recovery evidence remain provisional until manual review, time hold or another approved independent factor?
2. **Security hold:** Define whether and for how long an account stays restricted after recovery, and how trusted users are alerted and can contest an unauthorized recovery. **No hold duration has been approved**.
3. **All factors lost:** Define a genuine high-assurance support process, or explicitly choose no automated recovery. **Never** make a support agent's discretion, user-supplied business name, synthetic email or phone OTP alone into a bypass.
4. **Rotation and notifications:** Define how/when a replacement code is safely issued after use, key/pepper rotation retention, revocation of other sessions/credentials, notification destinations, and incident handling when no delivery channel exists.
5. **Feature boundary:** Confirm that C3b coding starts with database primitives, issuance/consume verifier and synthetic-data integration tests only, without publicly reachable code issuance or redemption; separately approve any HTTP recovery endpoint and actual passkey replacement.
6. **Duration:** Approve or adjust the proposed short-lived recovery-capability lifetime after threat review; expiry is **not** an authorization grant.

## C3b implementation acceptance — ONLY after the preceding design review

- Add a reviewed, forward-only migration for code batches, digests, redemption status, restricted-grant state and audit events (as needed). Preserve existing C3a and C2 schema/data and auth regeneration checks.
- Implement testable, backend-only issuance/verification/atomic-consumption primitives with clear errors and no secret leakage. Fail closed without the required server secret and without trustworthy enrollment evidence.
- Include PostgreSQL integration tests of uniqueness, plaintext absence, once-only display, digest mismatch, expired/revoked grants, multiple concurrent redemption attempts, replay, attempted cross-account code use, second-business privilege denial, code set rotation, session revocation and audit no-leak behavior.
- Test the **actual Fastify HTTP boundary**: unauthenticated/external/production requests to any unfinished recovery path are denied, even when development flags are set. Ensure Better Auth/C3a endpoints cannot bypass a restricted-recovery policy.
- Unit tests must not replace isolated PostgreSQL transaction and concurrency tests; use fake OTP transport, synthetic accounts and no real SMS.
- CI must pass build, typecheck, auth schema checks and migration drift, 56+ unit/integration tests, lint and formatting. Report exactly which tests ran and remaining limitations.
- Open a **draft PR**, stop for review, do not merge automatically. Do not modify C3a passkey login restrictions or activate C2 owner actions.

## References

- [NIST SP 800-63B, Account Recovery](https://pages.nist.gov/800-63-4/sp800-63b.html#account-recovery)
- [OWASP Forgot Password Cheat Sheet — secure recovery tokens and sessions](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)
- [ADR-006](../decisions/006-passkeys-recovery-and-step-up.md)

This **proposed** design adds no active authentication capability and is non-binding until reviewed. C3a's localhost-only WebAuthn test enrollment is separate from trusted recovery enrollment; do not confuse stored provisional credentials with approved owner recovery proof.
