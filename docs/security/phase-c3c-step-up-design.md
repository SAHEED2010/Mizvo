# Phase C3c — recent WebAuthn step-up: proposed security design

- **Status:** Proposed for independent security review; **no C3c implementation or activation is approved by this document**
- **Parent:** Build 002 Phase C, issue #8
- **Architecture:** [ADR-006](../decisions/006-passkeys-recovery-and-step-up.md)
- **Prerequisites:** C3a local-only verified-phone passkey enrollment merged in PR #16; C3b synthetic-only recovery primitives merged in PR #19
- **Baseline:** Better Auth 1.7.7 with phone-first user ID; Next.js browser at \`http://localhost:3000\`, RP ID \`localhost\`, Fastify private API; Drizzle/PostgreSQL; seven-day non-refreshing login session; C2 owner-sensitive endpoints **deny by default**

## Goal, non-goals and assurance boundary

C3c will eventually require a **fresh, cryptographically validated WebAuthn authentication assertion** before privileged owner operations. A login session, OTP, recently enrolled passkey, recovery-code grant or generic session-freshness flag is **not** an authenticated step-up. The design must distinguish (a) a valid cryptographic assertion from (b) **trusted-credential eligibility**, (c) the user's current membership/authorization, and (d) a later C3d permission decision.

**First implementation recommendation, subject to review:** an isolated **development/test-only internal step-up assertion verifier**, persistent one-time challenge/proof records and negative PostgreSQL + Chromium virtual-authenticator tests. No production/public step-up HTTP ceremony, passkey sign-in or privileged owner action. Do **not** wire internal proofs into \`currentOwnerSensitiveActionDecision\` or return \`allowed: true\` to business routes.

## Existing system constraints

1. C3a passkey registration binds credentials to the same Better Auth phone-first user, but every first passkey is **provisional** for owner management until a separate approved anti-SIM-takeover assurance policy. Merely enrolling a passkey or issuing C3b synthetic recovery codes must not promote it into a trusted owner credential.
2. The Better Auth passkey plugin exposes authentication-options and authentication-verification routes, but both are currently explicitly **blocked at Fastify**. Turning these on could unintentionally expose passkey login/session creation. Do not do that in C3c development.
3. C3b recovery codes and capabilities are **synthetic-test-only**, tied to an isolated \`mizvo_test\` database, and are not a trusted real-world recovery factor. They cannot satisfy C3c assurance or unlock C2.
4. The actual C2 \`currentOwnerSensitiveActionDecision\` has a fail-closed recovery and step-up verifier. The project has multiple businesses per user; current owner membership must be reloaded for every action and must not be inferred from selected business ID.
5. No approved canonical production HTTPS origin/RP ID, real OTP provider, trusted initial enrollment, public credential management or live recovery flow exists.

## Threat model and required invariants

| Attack or failure | Required protection |
| --- | --- |
| Captured, substituted or replayed challenge/assertion | CSPRNG challenge, short expiry, per-ceremony unique ID, one-time atomic consume, exact challenge match; reject duplicate/concurrent finalization |
| Signed assertion from wrong RP, origin or type | Verify clientDataJSON WebAuthn \`get\` type, expected origin, authenticator RP ID hash and all required server-side values |
| User presence but **no user verification (UV)** | Require cryptographically verified UV flag, not merely browser UI preference |
| Wrong account or unrelated passkey | Find credential by stable credential ID and bind server-side to **same Better Auth user**; reject user-handle/account mismatch and revoked/unknown credentials |
| Compromised session or stolen assertion response | Scope challenge to user ID, session ID, business ID, **specific action and target/context digest**, issue/expiry and server-side nonce; do not transfer proof between sessions |
| Approval for business A used at business B, different role, action or target | Verify exact scope on issuance and consumption, and re-read current organization membership/owner role **at use time** |
| Recovery, passkey change, logout or stale session after approval | Store/check revocation/security epoch, session validity, credential status and current membership; invalidate outstanding challenges/proofs upon security-sensitive state changes; design epoch updates before any future activation |
| Generic recent session or C3b restricted grant mistaken as step-up | Dedicated evidence type and server-side verifier; deny all cross-purpose tokens and generic \`freshSessionMiddleware\` as substitute |
| Credential counter rollback or cloned authenticator | Persist authenticated credential counter under concurrent-safe update; reject suspicious counter behavior per authenticator/backed-up policy and log only nonsecret audit metadata |
| Abusive proof requests or secret leakage | Rate limiting, exact Origin/Host checks on future HTTP boundary, no private key/challenge response in logs, response \`no-store\`, generic error detail |
| Provisional credential used as trusted owner factor | Cryptographic-verification result may be used in **synthetic tests**, but **must never** set owner-trust/recovery enrollment or authorize a sensitive operation |

A WebAuthn assertion proves use of a credential in response to a challenge; it does **not**, by itself, prove the user intentionally approved the specific business transaction. The UI must separately present what action is being confirmed. Approval-scope is enforced by trusted server-side challenge/proof binding, not untrusted client text.

## Proposed ceremony and proof model — review required

### Step 1 — Start an action-bound challenge

- Only an existing authenticated and **verified-phone** Better Auth account may be considered. For future real privilege use, independently established trusted-passkey provenance and trusted recovery enrollment also must be confirmed. For the first C3c development PR, use **synthetic verified users and test fixtures only**.
- Server re-loads the relevant business membership/role for the exact \`organizationId\`; verify intended action/target is well formed and permitted at initiation, but do **not** perform the sensitive action.
- Store a cryptographically unpredictable one-use challenge and server-chosen values for \`userId\`, \`sessionId\`, \`organizationId\`, \`action\`, \`targetDigest\`, \`credentialSecurityEpoch\`, \`expiresAt\` and \`status\`. No acceptance of client-chosen scope, session or account ID.
- Choose a bounded challenge lifetime (proposed **5 minutes**) and failure/retry policy **for review**. Generate WebAuthn authentication options for the current user's acceptable credentials; disable user-less/discoverable login as part of C3c.
- For internal tests, call vetted WebAuthn options functions and an isolated test verifier, not the blocked generic Better Auth login routes.

### Step 2 — Verify fresh WebAuthn authentication assertion

- Verify using an audited, version-compatible vetted implementation, preferably the same pinned underlying \`@simplewebauthn/server\` API supported by Better Auth 1.7.7; do **not** hand-write WebAuthn signature verification. Review the plugin source and library versions before coding.
- Check exact \`http://localhost:3000\` origin/\`localhost\` RP ID for **local tests only**, plus the signed challenge, \`type=webauthn.get\`, UV and credential signature against the stored public key.
- Require the assertion's credential ID to belong to the same user; verify the current Better Auth session and membership/role, and validate challenge's exact business/action/target/session scope. Treat a session change, logout or timeout as failure.
- Verify credential status and any security/assurance epoch. *Provisional C3a passkeys may be used to demonstrate signature verification in isolated tests only; their proof is not eligible for owner authorization.*
- Atomically consume the challenge and update the credential counter/clone-signal status when appropriate. Ensure concurrent submissions cannot produce two successful grants.

### Step 3 — Record and consume narrow recent evidence

- Proposed **server-side evidence record**, not a user-controlled "fresh" timestamp or reusable browser token, bound to \`userId\`, \`sessionId\`, \`businessId\`, \`action\`, \`targetDigest\`, authenticating credential, security epoch, \`issuedAt\`, \`expiresAt\` and \`usedAt\`.
- **Maximum proof age: 10 minutes**, from completion of signature verification. Design more stringent single-operation expiry for particularly consequential changes (e.g., owner transfer). Consider single-use for every sensitive action so the same assertion cannot approve multiple transfers/invitations. Define exact consumption semantics before activation.
- For future C3d: verify the real current membership and role, current session validity, latest credential/recovery epoch and exact action target at use; atomically consume proof with privileged action authorization as feasible. C3c development must still return **deny** for C2 actual routes.
- Record redacted audit metadata (credential ID should be minimized or pseudonymized as policy allows); never log raw challenge, signature response, sensitive browser payload, private keys, recovery codes or ordinary session tokens.

## Deployment and endpoint policy

- First C3c PR **must not expose any public HTTP step-up initiation or verification routes**. The test harness may run actual Chromium virtual WebAuthn assertions against an isolated internal test adapter. Avoid enabling the Better Auth plugin's generic authentication options/verification paths through Fastify.
- All production and public/staging step-up endpoints remain absent/404. A future, separately reviewed endpoint design must cover exact Origin, trusted Host/proxy, CSRF/cookies, credential ownership, browser compatibility and frontend accessibility. A dev flag or hidden UI is not server authorization.
- No changes to Better Auth's canonical identity, seven-day session lifetime, C2 guards, real recovery, passkey login, staff invitation acceptance or tenant restrictions. No new domain purchase, provider provisioning, deployment or real customer data.

## Security decisions required before coding beyond isolated tests

1. **Verifier/library interface:** Use which versioned WebAuthn assertion verifier? Audit the pinned Better Auth plugin for potential session-creation side effects, and avoid turning authentication endpoints on.
2. **Credential trust:** Define how an existing *provisional* C3a passkey could ever become eligible for owner step-up. Do not equate simulated C3b codes with live independent recovery.
3. **Challenge/proof persistence:** Approve schema, one-time semantics, credential counter concurrency and retention/audit rules, target-digest strategy, and proof invalidation/security epoch lifecycle. No raw bearer secrets.
4. **Expiry and scope:** Confirm five-minute proposed challenge expiry; maximum ten-minute proof, with action-specific one-use semantics and target binding, and treatment of retry/failed operation.
5. **Revocation:** Exact behavior on logout, session revocation, credential rotation, account recovery, business membership changes and ownership transfer.
6. **Production device/domain:** Stable HTTPS origin, RP ID/re-enrollment plan, real Android/iOS/desktop browser tests and production recovery readiness.
7. **HTTP readiness:** Decide whether any local UI/HTTP endpoints are necessary in a *later* PR after service-level security review; production remains off.

## Proposed test acceptance for a future scoped C3c development PR

- Isolated PostgreSQL \`mizvo_test\` + \`NODE_ENV=test\`, synthetic users and a Chromium virtual authenticator; genuine valid registration followed by **authentication assertion** signature verification and counter progression. Keep browser \`localhost\` RP rules.
- Wrong/missing UV, wrong origin/RP/challenge, modified signature, unknown/other-user credential ID, expired/revoked session, expired/replayed/concurrently consumed challenge, stale/reused evidence, cross-business, cross-action/target, removed/demoted owner, and counter anomaly cases.
- Provisional C3a credential proof cannot unlock C2; fake C3b restricted capability and phone OTP cannot satisfy step-up. Owner-sensitive routes remain 403 before and after tests.
- Production Fastify denies all generic passkey login, unreviewed credential modifications, step-up and recovery HTTP paths, including when dev flags are mistakenly set.
- Drizzle forward migration only if required, validate schema regeneration/migration drift; full build, typecheck, PostgreSQL suite, lint and formatting green; document virtual-vs-physical authenticator limitation.
- Open a **draft PR** on a branch from the latest CI-green \`main\`, request independent review and stop. **Never merge automatically.**

## References

- [ADR-006](../decisions/006-passkeys-recovery-and-step-up.md)
- [C3a enrollment implementation boundary](phase-c3a-passkey-enrollment.md)
- [C3b synthetic recovery boundary](phase-c3b-implementation.md)
- [W3C WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/)
- [SimpleWebAuthn server documentation](https://simplewebauthn.dev/docs/packages/server)
- [Better Auth Passkey plugin](https://www.better-auth.com/docs/plugins/passkey)

**No C3c code, privileged action, account recovery or passkey authentication endpoint is approved by drafting this design.** All production activation and any permission-gate removal require separate architecture/security approval.
