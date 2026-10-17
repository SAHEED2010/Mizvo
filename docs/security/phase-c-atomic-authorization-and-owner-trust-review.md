# Phase C security gate: atomic proof-to-business mutation and trusted-owner prerequisites

- **Status:** Proposed architecture/security review; design evidence only; **no live implementation approval**
- **Date:** 2026-10-17
- **Basis:** ADR-006; [C3d security design](phase-c3d-protected-actions-design.md); [C3d test-harness implementation](phase-c3d-implementation.md); C3a/C3b/C3c security implementation boundaries
- **Last green baseline:** Main \`418877cfdee3bd8b0776815797a8ce2ad713c126\`, PR #25, [post-merge CI #39023613111](https://github.com/SAHEED2010/Mizvo/actions/runs/39023613111) **success**
- **Authority:** Review-only. Approval/merge of this document will **not** authorize a code PR, production authentication, permission changes or launch.

## 1. Problem statement and demonstrated boundaries

Current C2 invitation create/revoke helpers use \`runWithTransaction(context.adapter, ...)\` from \`@better-auth/core/context\` and use the current Better Auth adapter for membership checks, invitation state changes and business audit. C2 recipient acceptance similarly uses Better Auth's server-only \`auth.api.addMember\` inside the adapter transaction. Mizvo configures \`drizzleAdapter(database.db, { provider: "pg", schema, transaction: true })\` over \`createDatabase\`'s postgres.js client and Drizzle instance.

The synthetic C3c verifier instead consumes proof via a caller-owned postgres.js \`TransactionSql\` and row/advisory locks. C3d PR #25 proved **one transaction for that proof plus one synthetic effect row**, with exact scope, replay, failure rollback and exactly-once tests. It **did not** prove atomic consumption with actual C2 invitation writes or a Better Auth Organization mutation.

A shared database URL, pool or transaction *name* is **not a single transaction**. Calling C3c \`client.begin\` within Better Auth's \`runWithTransaction\`, or vice versa, is **not** safe evidence of atomicity and can create separate connections, partial commits or lock deadlock. The current \`currentOwnerSensitiveActionDecision\` is deliberately deny-by-default and the abstract \`evaluateOwnerSensitiveAction(userId, evidence)\` is **insufficient** to authorize a specific session/business/action/target.

In pinned Better Auth v1.7.7 source, \`runWithTransaction\` uses an AsyncLocalStorage transaction adapter; the pinned Drizzle adapter constructs that adapter from a \`db.transaction((tx) => ...)\` callback. Those internals show possible *research directions*, **not** a supported raw-Drizzle transaction handle exposed by the public C2 helper. We must validate any bridge using the pinned APIs, type checking and PostgreSQL tests—not inferred compatibility with a newer release.

**Hard current rule:** C2 public owner-sensitive routes continue to return denial; C3a provisional passkeys, C3b test codes and C3c/C3d synthetic proof/effects cannot authorize a real owner action. This design does not relax that rule.

## 2. Security invariant: one authorized action, one commit boundary

The desired future invariant is:

> Either (a) one trusted, fresh WebAuthn step-up proof for the exact user, Better Auth session, organization, action and canonical payload is **consumed together with exactly that authorized business mutation and its audit** in one database commit, or (b) **none** of those changes commits.

Concretely, a candidate design must:

1. Resolve the actual Better Auth **user and current session** on the server, reject logout/revocation/expiration and never accept user/session identity from the JSON body.
2. Load and lock current Organization membership and role for the *specific organization*. Require owner for invite create/revoke; recheck role and relevant target under the **same transaction** as the mutation. Keep cross-business selection and last-owner rules enforced.
3. Require separately approved **trusted** credential provenance, independent recovery enrollment and a **fresh cryptographically verified WebAuthn assertion**; synthetic C3c proof is never sufficient for real privileges. Preserve required user verification, exact RP/origin, one-time challenge, credential/counter and security epoch checks.
4. Consume one narrow proof bound to session, user, business, exact action, **server-canonical target/payload digest**, trusted credential and recovery/security epoch. Maximum proof lifetime remains 10 minutes; consider a shorter limit and stronger confirmation for high-consequence operations.
5. In the **same transaction/connection**, perform the specified owner-only invitation mutation, apply record-scope and role allowlists, and append nonsecret audit metadata. A failure *at any point* must roll back proof consumed flag, invitation/audit and any relevant database side effects.
6. Coordinate row/advisory locks consistently with recovery issuance/redemption, credential rotation, role/membership mutation and session invalidation. Specify order to avoid deadlocks; reject stale privilege if any concurrent change wins.
7. Expose no uncontrolled callback or separately injected arbitrary proof consumer in an eventual production authorizer; prevent changing the operation after the user approves it. Make the browser confirmation description match the trusted server-canonical action context.
8. Do not run external SMS/WhatsApp, network or notification delivery inside the DB transaction. Any later approved communication needs post-commit handling or a transactional outbox with idempotent dispatch, no premature "delivered" claim.
9. Preserve tenant isolation, recipient restrictions and deny-by-default behavior when any verification, transaction or notification assumption fails.

**Recipient invitation acceptance is a separate action class:** the authenticated intended verified-phone recipient may accept without an owner passkey/step-up. Its pending-token claim and membership writer must remain atomic and scoped. The presently disabled HTTP acceptance route should not inadvertently apply the owner-only guard after a future independent recipient-route design.

## 3. Candidate transaction architectures — not yet selected

### Candidate A: Better Auth/Drizzle transaction as the sole owner

Refactor the test-only C3c proof-consumption queries behind a narrow transaction-bound **Drizzle execution capability**, so proof locking/consume and the existing Better Auth invitation services can be invoked with **one** Drizzle transaction. Research whether the pinned Better Auth adapter can expose/reuse the **same transaction context** for trusted application-domain SQL through a supported, stable interface. No calling an independent postgres.js \`client.begin\`. Retain Better Auth as canonical session and Organization membership authority.

**Open question:** v1.7.7's transaction adapter is created from a captured \`tx\`, but \`getCurrentAdapter\` exposes Better Auth adapter methods, not necessarily a raw Drizzle \`tx\`. Do **not** type-cast private internals or rely on AsyncLocalStorage internals as the security design. A supported extension/bridge must be identified and tested.

**Pros:** C2's existing Better Auth operations and membership writer are more likely to remain canonical; no divergent mutation path.
**Risks:** No proven supported capability for raw proof SQL inside the same Better Auth transaction; nested callback behavior and after-commit hooks must be reviewed.

### Candidate B: Application-owned Drizzle transaction with a transaction-scoped Better Auth adapter

An application-owned \`database.db.transaction(tx => ...)\` could theoretically supply a Better Auth adapter scoped to \`tx\`, while the proof and invitation SQL use that exact \`tx\`. Research **supported** adapter/context injection for Better Auth v1.7.7. Audit \`auth.api.addMember\`, \`runWithTransaction\`, \`getCurrentAdapter\`, plugin hooks, and any implicit transaction creation or session refresh. Do not build a homegrown AsyncLocalStorage bridge or deep import.

**Pros:** Explicit owner of one connection and one commit boundary, if supported.
**Risks:** The existing \`runWithTransaction\` starts/joins a Better Auth transaction through its configured adapter. A transaction-scoped custom adapter might not support those APIs or after-commit semantics and could silently escape into another DB session. This is an **experiment hypothesis**, not a recommendation to deploy.

### Candidate C: Database transaction/function performs proof + invitation mutation

A reviewed PostgreSQL function invoked through one connection could prove atomic proof consumption with an invitation-state row and audit, **but** direct writes to Organization membership or bypassing the existing Better Auth server-only membership writer would violate ADR-006. If pursued for **invitation metadata only**, it still needs accepted domain-service ownership, parity with C2 invariants and a separate architecture decision.

**Do not use for real Organization member-role changes without a new approved authority boundary.**

### Rejected: independent transactions, sagas or "consume first, mutate second"

A compensation/retry scheme, redis lock, cross-pool advisory lock alone, two unrelated commit points, independent read-only authorization followed by a mutation, or calling C2 before a separate proof commit does **not** meet the proof-once-and-mutation-once invariant. Reject even if happy-path tests pass.

### Recommended research priority

1. Investigate **Candidate A** against pinned v1.7.7; use only supported transaction APIs and prove one rollback/commit.
2. If A cannot preserve the adapter/writer authority, test B's feasibility **in isolated design spikes**; stop when a supported API cannot be demonstrated.
3. Do not silently choose C or rewrite Better Auth Organization semantics as a workaround. If all candidates are unsupported, retain deny-by-default and record a dependency/design blocker.

## 4. Minimum evidence for a later *approved* isolated transaction spike

No code spike is authorized by this document alone. If separately scoped and approved, use only \`NODE_ENV=test\`, an explicit local loopback connection to PostgreSQL \`mizvo_test\`, synthetic Better Auth users, a fake SMS transport, and synthetic C3c credentials/proofs. Never mount test services in Fastify.

Require all tests below before approving a real-authority transaction design:

| Test / observation | Pass criterion |
| --- | --- |
| Single DB transaction | Proof consumer, domain writer and audit all report **same backend PID / same transaction ID and same commit/rollback** (use probes that do not cause unrelated mutations) |
| Injection point | Test-only invalid/stale/wrong-business/wrong-session/action/target/owner and fake proof consumer cannot reach a domain mutation |
| Forced failure after proof | No used proof, no invitation change and no audit row persist |
| Forced failure after invitation write | The previously valid proof remains available and **all** domain effects disappear |
| Forced failure at audit/write constraint | All writes—including proof consumed flag—roll back |
| Replay and contention | Concurrent attempts with the same proof yield **exactly one** completed operation and one audit, with no double invitation |
| Membership change and recovery race | Owner demotion, security epoch bump, credential deletion, session revoke or recovery event cannot leave an unauthorized committed operation; lock order and deadlock retries documented |
| Cross-tenant effects | A proof for organization A/target A cannot change organization B/target B |
| Canonicalization | Create proof digest includes exact normalized recipient, role and business; revoke includes specific pending invitation; user confirmation displays that action |
| Better Auth membership authority | Accepted recipient follows Better Auth Organization's supported server-only addMember path in one transaction; owner creation/revoke do not create owner memberships |
| Isolation and HTTP denial | Test client refuses nonlocal DB and real accounts; public owner endpoints, generic passkey sign-in and real recovery stay absent/denied in every environment flag combination |
| Schema and CI | Forward migrations only if needed, schema regeneration stable, PostgreSQL/Chromium suite plus build/typecheck/lint/format green |

A passing test that only writes \`protected_action_test_effect\` **does not** satisfy the "actual C2 invitation mutation" requirement. A **transaction capability proof-of-concept** with no real domain write may still be a useful design result but must be labeled incomplete.

If the result is ambiguous, **stop, document the limitation and do not open owner-sensitive routes**.

## 5. Separate mandatory real-owner trust and recovery decisions

These are **independent approval gates**, even if a future transaction proof-of-concept is successful.

| Decision | Current source-supported fact | Evidence and explicit decision required |
| --- | --- | --- |
| First passkey trust | C3a credentials are provisional for owner privileges; a new signed assertion does not prove trusted initial enrollment | Threat model for SIM swap/phone reassignment and new-device enrollment, trusted out-of-band confirmation and an explicit provisional-to-trusted policy |
| Independent recovery enrollment | C3b's recovery codes/capabilities are limited to synthetic \`mizvo_test\`; no real recovery HTTP issuance/redemption | Define secure first issuance, independent factor proof, controlled credential replacement, revocation, code rotation/key lifecycle and no OTP-alone privilege |
| Recovery hold/contest | No reviewed production hold duration or notices/provider exists | Decide held/restricted capabilities, notices to independently trusted channels, appeal/contest path, account theft risk and all-factors-lost outcome; do not invent a default interval |
| Production WebAuthn identity | C3a/C3c use exact \`http://localhost:3000\` and RP ID \`localhost\` in tests only | Choose durable production HTTPS host/RP ID and explicit re-enrollment/migration; test real Android/iOS/desktop and WhatsApp in-app-browser behavior |
| HTTP step-up design | No public signed assertion challenge/verify/step-up endpoint approved | Server-generated scope, Origin/Host/trusted proxy/CSRF policy, session binding, UI action confirmation, authenticators, replay and anti-abuse rules |
| Privileged action policy | C2 create/revoke/member/transfer HTTP routes are deny-by-default | Action-specific policy matrix: which owner changes permitted, self-change/last-owner safeguards, invitation recipient roles, audit and retention |
| Live messaging and launch | SMS/WhatsApp provider and customer onboarding activation not approved | Provider threat model, verification/delivery semantics, operational monitoring, rollout/rollback and independent security review |

**Do not conflate three different states:** (a) valid phone OTP and Better Auth login, (b) provisional/test-only WebAuthn or synthetic recovery evidence, and (c) independently trusted enrolled owner factors. Only the separately reviewed production policy can define (c). A placeholder \`@users.invalid\` email is never an email-recovery destination or a shortcut to trusted status.

### Decision points reviewers must answer rather than silently assume

- Is there an acceptable, *independently verifiable* first-enrollment and recovery-bootstrap process when a phone-only owner has no previously trusted factor? If not, continue denying privileged actions.
- What is the permissible restricted recovery capability, what must it **never** enable, what are the independent notices/contest mechanisms, and what happens when every factor is lost?
- Which stable HTTPS WebAuthn RP ID will be used and how will local/temporary-domain credentials be handled?
- Which transaction approach is compatible with the **pinned** Better Auth and Drizzle APIs while retaining Organization membership as canonical writer?

These choices need their own architecture/security approval **before** any live code or user-facing flow.

## 6. Scope, sequencing and stop conditions

**This PR is documentation-only.** It changes no TypeScript, migrations, Fastify routes, C2 guards, browser plugin endpoints or deployment.

After an independent review and explicit project-owner design approval, a *separate* issue may authorize **only an isolated compatibility/transaction experiment**. The researcher must prove same-transaction capabilities without implementing new public endpoints or mixing trusted production enrollment with synthetic fixtures. If A/B cannot be demonstrated safely, stop with a written blocker and evidence.

A second, later **real-owner trust and recovery security design** must be approved before any C3 activation. A final real invitation/member/ownership action activation PR requires all independent trust, WebAuthn, shared transaction, audit, provider and customer-gating decisions plus device tests. No stage can infer authorization from green CI alone.

## 7. Pinned source references

- Mizvo [C2 invitation source](../../apps/api/src/auth/phone-invitations.ts), [auth configuration](../../apps/api/src/auth/auth.ts), [database client](../../packages/database/src/index.ts), [C3c proof verifier](../../apps/api/src/auth/step-up-test-service.ts), [C3d harness](../../apps/api/src/auth/protected-action-test-harness.ts), [C2 deny guard](../../apps/api/src/auth/owner-sensitive-action-guard.ts)
- [Better Auth v1.7.7 transaction context](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/core/src/context/transaction.ts): AsyncLocalStorage-backed \`runWithTransaction\`, \`getCurrentAdapter\`, \`runWithAdapter\`
- [Better Auth v1.7.7 Drizzle adapter](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/drizzle-adapter/src/drizzle-adapter.ts): \`transaction: true\` uses \`db.transaction\` with an adapter built for the callback transaction
- [Drizzle transaction documentation](https://orm.drizzle.team/docs/transactions): a transaction must own the complete set of writes and rollback
- [ADR-006](../decisions/006-passkeys-recovery-and-step-up.md), [C3b synthetic recovery boundary](phase-c3b-implementation.md), [C3c WebAuthn proof boundary](phase-c3c-implementation.md)

**Explicit non-approval:** Neither this document, its PR merge, a successful synthetic proof, nor a reviewer comment is permission to enable production passkeys, recovery, SMS/WhatsApp, owner-sensitive HTTP actions, real-user account changes or deployment.
