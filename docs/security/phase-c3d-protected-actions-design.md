# Phase C3d — Protected business actions: proposed security design

- **Status:** Proposed for independent security review; **not approval to enable any privileged route**
- **Date:** 2026-10-16
- **Architecture:** [ADR-006](../decisions/006-passkeys-recovery-and-step-up.md), ADR-001, ADR-002, ADR-007
- **Foundations:** C1 business membership; C2 phone-invitation internals and HTTP deny gate; C3a provisional local WebAuthn enrollment; C3b isolated synthetic-code verifier; C3c isolated signed-assertion test service (merged PR #22)
- **Tracking:** Build 002 Phase C issue #8

## Executive decision

**C3d must not activate owner-sensitive HTTP actions yet.** The current C3a, C3b and C3c credentials, recovery capability and proof are **development/test-only**. A verified signature on a provisional passkey does not establish the required independent trusted owner recovery. Before any production action endpoint is enabled, a separately reviewed real-user security enrollment/recovery design, credential-trust lifecycle, production WebAuthn RP/origin, user-facing step-up and proof-to-mutation atomicity must be approved and tested.

The *next safe coding milestone*, if approved after review, is a **synthetic-only PostgreSQL authorization/transactional test harness** for the existing C2 phone-invitation service and C3c proof interface. It must not expose new public HTTP routes, promote C3c test proof, relax \`currentOwnerSensitiveActionDecision\`, enable real member/ownership changes, or create any path to live privileges. All owner-sensitive HTTP routes must continue to deny.

## Threats and invariants

| Threat | Required invariant |
| --- | --- |
| Compromised SIM/phone OTP, provisional C3a passkey, or synthetic C3b codes | None counts as **independent trusted owner security enrollment**; production authorization stays denied |
| Replayed or generic step-up token | Use cryptographically verified WebAuthn assertion; evidence must be one-use and bound to user **and current session, organization, action, exact canonical target/payload and security epoch** |
| Switch business after proof, changed role or revoked session | Recheck current Better Auth session and Organization membership/owner role under appropriate concurrency protection at the exact mutation boundary |
| Role escalation, inviting an owner, demoting/deleting last owner | Explicit server-side role allowlist, tenant scope and existing PostgreSQL last-owner invariants; no direct client role trust |
| Unauthorized invite accept/redeem | The **authenticated intended phone recipient** may accept, without an owner step-up; derive recipient identity from Better Auth session, re-read verified phone, perform atomic invitation claim + membership creation |
| Other tenant's invite/member/ownership record | Derive organization scope from verified context and verify every selected record belongs to that exact organization; never use a client-supplied active-business ID as authority |
| Concurrent owner changes, double invite redemption or reused proof | Guard and domain mutation must be atomic with proof consumption or fail closed; specify exact transaction/retry/rollback handling before activation |
| Bypass through Better Auth Organization or Passkey plugin routes | Keep unrestricted browser-facing plugin namespaces blocked; use reviewed server-only domain service |
| Owner-lifecycle audit tampering, leaked tokens/phones | Append-only structured audit with redaction; never log plaintext phone-invitation token, OTP, recovery codes, step-up payload, raw browser assertion or session cookies |
| False success after unavailable OTP/provisioning | Production SMS/WhatsApp delivery remains disabled until real provider and verification gates; UI and API must not claim invitations were delivered |

## Separate the action classes

### A — Invitation acceptance: intended recipient, not owner

The recipient must have a valid Better Auth session and verified phone identity. The server, not the JSON body, supplies canonical \`recipientUserId\`. The internal \`acceptPhoneInvitation\` service already compares a keyed hash of the *current verified phone*, checks 48-hour expiry and pending state, and invokes the Better Auth Organization member writer transactionally. **It does not require owner privilege or a fresh passkey step-up.**

Future HTTP acceptance requires its own CSRF/origin, abuse throttling, no-enumeration errors, replay and role/tenant tests; do **not** accidentally let the current owner-only HTTP guard become the final acceptance rule. The existing HTTP route remains disabled until separately approved.

### B — Owner-only invitation creation/revocation

Require current owner membership in the exact target organization **and** independent trusted recovery enrollment **and** a fresh valid action/recipient/role/organization/session-bound WebAuthn assertion. Input canonicalization matters: proof target must incorporate the *exact normalized recipient phone/role/invite ID and intended operation*, not merely a human-readable label. Owner may create a manager/staff/viewer invitation, **not** owner invitation.

The reviewed C2 internal helpers are candidates for later wiring, but their current individual transaction boundaries must be revisited for atomic integration with proof consumption. There is no public live approval today.

### C — Member removal or role change

Always re-read target membership and organization, actor owner membership, last-owner protection, permitted role and target restrictions at execution time. Do not allow a change to confer owner status or silently transfer ownership through a generic role-change route. Define exact safeguards for self-demotion, simultaneous changes, owner target removal and privilege upgrades before implementation. Not part of the next isolated test-harness phase unless separately scoped.

### D — Ownership transfer

Treat as its own security design requiring stricter fresh assertion, explicit owner and recipient confirmation, protection against compromised contact details, independent recovery readiness for the incoming owner and audit/revocation. **No ownership-transfer route activation in the initial C3d phase.**

## Production action authorization (future, not yet available)

For a prospective owner mutation, in order:

1. Resolve a current verified-phone **Better Auth session** through trusted same-origin cookies; enforce CSRF/Origin and trusted proxy host policy.
2. Load actual **Organization membership** of that user in the exact business; require \`owner\` at the point of mutation, not only challenge issuance.
3. Check approved trusted passkey and independent owner-recovery enrollment provenance. A C3a-only credential or \`recovery_test_identity\` row cannot pass.
4. Require an independently validated **new** WebAuthn assertion on the same owner/credential/session, proving user verification, one-time challenge and exact stable RP ID/origin; do not enable the Better Auth generic authentication route that creates an unrestricted session.
5. Check proof maximum age **10 minutes** (stricter for some actions), proof-used flag, security/recovery epoch, action/target digest, current credential state, current membership and fresh active session.
6. Consume the proof and commit the *exact intended* business mutation with transactional semantics that cannot double-use the proof or partially change membership. Design the cross-layer Better Auth adapter/Drizzle transaction integration and failure behavior first; do **not** assume nesting two unrelated transactions is atomic.
7. Append a nonsecret audit event with actor, organization, action, subject and outcome; apply post-commit notifications only where approved trusted channels actually exist.

**Importantly:** the existing \`evaluateOwnerSensitiveAction(userId, evidence)\` abstraction does not bind proof to business, action, target or session and is **not a sufficient production authorization API**. The \`currentOwnerSensitiveActionDecision\` wrapper currently always denies. Any future replacement must bind and verify the full action context and be independently reviewed.

## Approval matrix (hard blockers)

| Decision | Current state | Needed before action activation |
| --- | --- | --- |
| Production canonical HTTPS RP ID and trustworthy proxy/origin | Unselected | Approved durable origin/hostname and real-device tests |
| First passkey enrollment and SIM-swap takeover defense | Provisional C3a only | Reviewed independent trusted eligibility and promotion policy |
| Real owner recovery codes & independent enrollment | C3b synthetic test only | Verified live issuance/rotation, hold, notifications and loss-of-factors policy |
| Real step-up HTTP ceremony | C3c internal test only | Reviewed UI/CSRF, signed assertions, session binding and evidence lifecycle |
| Atomic proof + business mutation | No production integration | Review transaction scheme, retry/idempotency/rollback guarantees and concurrency tests |
| Live messaging and real customers | Disabled | Explicit provider security/delivery/provisioning approval |
| Audit and retention | C2 invitation events only | Approved expanded event schema, privacy and deletion/retention policies |

No value in this matrix may be satisfied by a development flag, manual insertion into a synthetic fixture table, placeholder email, phone OTP alone, or a developer claiming CI passes.

## Proposed scope of the *next* C3d engineering PR (subject to design approval)

- **Internal test-only transaction and policy harness**, \`NODE_ENV=test\`, isolated loopback PostgreSQL database \`mizvo_test\`, explicitly marked synthetic identities. Keep the Fastify C2 routes *unchanged* and deny-by-default; no new user-facing endpoints.
- Build precise action-context validation and a test-only interface that consumes *synthetic* C3c action-bound proof while performing an existing C2 invite create/revoke mutation in a deliberately shared transaction, **if and only if** the Better Auth adapter and transaction isolation truly support that. Otherwise, document the atomicity blocker and stop; do not implement non-atomic privilege grant.
- Test intended recipient **acceptance** as a separate, low-privilege authorization path with test-only session-derived identity; any actual HTTP wiring requires later approval.
- Document action policy matrix and all unsupported operations; do **not** fake a production trusted-recovery verifier or silently flip \`allowed: true\` in the C2 guard.
- Validate last-owner invariants, cross-business isolation, wrong target/session/action, revoked owner role, replay/concurrent proof use, invitation token replay, partial failure rollback, fake session, simulated OTP-only/codes-only, unreviewed plugin-route denial and audit sanitization.
- Keep the 7-day session maximum, Better Auth user/session and Organization memberships canonical, and C3a/C3b/C3c tests green.
- If schema changes are unavoidable, add forward migrations and check auth-schema regeneration/drift; run full CI including PostgreSQL/Chromium negative tests, lint and formatting.
- Create a separate branch from the latest **post-merge CI-green \`main\`**, open a **draft PR**, request independent security review and stop. No auto-merge.

## Reconsideration and sequencing

If the trust, recovery and atomic mutation model cannot be established safely as an isolated internal test harness, implement **only design/transaction tests** and leave the actual action-mutation integration blocked. A later **C3d activation PR** requires a *separate explicit product/security decision* and must not be bundled with synthetic test infrastructure.

## References

- [ADR-006](../decisions/006-passkeys-recovery-and-step-up.md)
- [C3c test-only implementation](phase-c3c-implementation.md)
- [C3b test-only implementation](phase-c3b-implementation.md)
- [C3c security design](phase-c3c-step-up-design.md)

**This document changes no live application behavior.** C3d is not a mechanism for removing C2 authorization gates before independent real-account recovery and signed passkey step-up have been approved.
