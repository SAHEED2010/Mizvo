# ADR-002: Phone-first authentication, business memberships, invitations and recovery

- **Status:** Accepted
- **Date:** 2026-10-14
- **Decision owners:** Mizvo team
- **Depends on:** [ADR-001: Multi-business accounts and authorization](001-multi-business-identity-and-access.md)
- **Implementation status:** Not implemented; requires reviewable changes, configuration and tests

## Context

Mizvo is a real, multi-tenant financial application. Individuals may register via the website or through the **official** WhatsApp Business Platform (once eligible and configured), and may own or work for several businesses with independent roles. Requiring an email address would exclude some phone-first merchants. Sensitive financial and membership actions need stronger safeguards than an ordinary authenticated session.

## Accepted decisions

### 1. Identity and sign-in

1. Use **Better Auth** on the **Fastify backend**, with the **Drizzle adapter** and **Neon PostgreSQL**. The web application uses the same authentication service; do not build a second identity store.
2. Enable Better Auth **Phone Number** and **Organization** plugins. Define custom business roles **owner**, **manager**, **staff** and **viewer/accountant**, retaining the permission model in ADR-001.
3. Allow **registration and sign-in on the website using a verified phone number**. Initial phone-first website login may use a correctly delivered and verified one-time passcode; email is **optional**, not a condition of creating a business account.
4. Also support onboarding through the **official Meta WhatsApp Cloud API**, subject to Meta terms, platform account eligibility and a verified delivery/integration configuration. The WhatsApp conversation itself is not a website session.
5. A user can voluntarily add a verified email and use approved email-based sign-in/password-recovery methods if configured. Never send resets or invitations to an unverified or synthetic email.
6. User IDs remain stable internal identifiers; a phone number and a WhatsApp sender ID are not primary keys or sufficient evidence of ownership of an existing Mizvo account.
7. Phone-only sign-up currently requires Better Auth's `signUpOnVerification.getTempEmail`. Generate a unique non-deliverable placeholder using a reserved invalid domain, clearly distinguish it from a real verified email, never mark it verified and never treat it as a recovery or invitation address. Review actual plugin behavior and test this case.

### 2. Phone verification and WhatsApp security

1. Use one-time verification codes with **five-minute expiry**, **at most three incorrect verification attempts** per code, and single-use/atomic consumption. Limit code requests and resends by recipient, IP/account when relevant, and by delivery channel. Make failure responses non-enumerating.
2. Send passcodes only via an approved, working delivery provider. An official WhatsApp authentication template is an option only if Meta permits the use case; a compliant SMS delivery provider may be a separately approved alternative. **No real-user signup is permitted if there is no verified way to deliver/validate codes.**
3. Verify Meta webhook subscription and the authenticity of incoming POST requests using the app secret signature; protect against duplicates and replay. Do not disclose OTP values in logs.
4. Never turn an unsolicited WhatsApp message or a client-supplied phone number into an authenticated account, business ownership, a browser session, or permission to read records. Account creation and linking must use the verified flow and backend identity checks.
5. Phone changes and account linking require verification of the new phone plus step-up proof of the existing account (or a separately approved high-assurance recovery process). Do not auto-merge records by matching unverified phone/email data.
6. A phone number alone does not independently prove legal business ownership. A WhatsApp user who belongs to multiple businesses must explicitly select the target business for authorized actions.

### 3. Session and authorization requirements

1. Browser authentication uses **Secure**, **HttpOnly**, appropriately scoped session cookies in production; use HTTPS, SameSite policy, origin/CSRF protections, restricted CORS and trusted origins. Prefer a **same-site/same-origin proxy topology** between Next.js and Fastify where possible; do not assume cross-site cookies are reliable.
2. Browser sessions have an **absolute maximum of seven days** from authentication, not rolling seven-day renewal. Implement and test the actual expiry policy; Better Auth's default sliding refresh **does not** by itself provide a hard seven-day maximum.
3. Reauthenticate within **ten minutes** before sensitive operations. Track real proof of recent authentication/step-up; the presence of an old session is not sufficient. Check recovery enrollment as a separate prerequisite for owner-only sensitive operations.
4. Revalidate current user, membership, business ID and role for every protected API, file, AI, financial or administrative request. Do not trust a browser-selected organization ID or cookie cache alone as authorization.
5. Revoke/invalidate sessions as appropriate for account compromise, phone/account recovery and credential changes. Membership removal/role changes must take effect promptly even when the browser retains a valid sign-in session; do not cache stale role grants.

### 4. Owner recovery and sensitive actions

1. Owners may register and create a business with a verified phone **without** supplying email.
2. **Before the owner may take sensitive account-management actions**, require enrollment of **at least one additional recovery method distinct from the phone-only sign-in channel**, e.g. verified independent email, a suitably enrolled passkey, or securely generated single-use recovery codes.
3. Require recent reauthentication/step-up for: inviting/removing members, changing roles/ownership, changing or unlinking a verified phone, issuing credentials, changing recovery methods, exporting/sharing sensitive financial reports, and deleting or irreversibly modifying the business.
4. Staff and viewer/accountant users may enroll an additional recovery method **optionally**; ordinary staff actions still require valid authentication and business authorization.
5. Recovery secrets/codes must be securely generated and stored only as non-reversible verifiers where applicable, never logged or retrievable in plaintext after issuance, and invalidated on redemption. Avoid insecure support-agent/manual bypasses.
6. The **concrete** recovery implementation (passkey/recovery-code UX, cryptographic library/provider, and account-lockout recovery procedure) must receive a security review before enabling owner-sensitive actions. An unconfigured recovery method must not be silently marked enrolled.
7. Losing the phone with no valid secondary method must not automatically grant account access based on name, business claims or support messages.

### 5. Business membership and invitations

1. Use the **Organization plugin** as the canonical user↔business membership authority. Treat each organization as a Mizvo business identity, with separate business-profile attributes if needed; avoid duplicate membership sources of truth.
2. Owners can invite members to their business, assigning one approved role per business membership. One user may belong to multiple organizations with distinct roles.
3. Email invitation flow uses Better Auth's invitation support **only for real verified email identities**, respecting the plugin's email-match and verification requirements.
4. **Phone-only invitations require a custom server-side invitation and acceptance flow**; do not pass synthetic email placeholders to the Organization plugin's email invitation API or turn off email-verification checks to bypass phone-first requirements.
5. All invitations expire after **48 hours**, are revocable and **single-use**, and require recipient authentication plus control of the matching verified phone or email before the backend creates membership.
6. Server-side addition of a phone-invited user through the Organization plugin must happen **only after** the custom invitation has been validated and atomically consumed. Guard against parallel acceptance/replay and owner/role tampering.
7. Prevent the last owner of a business from leaving, being removed or being demoted. Record role grants, revocations, ownership changes and invitation acceptance in an audit log.

## Roles and authority

Follow ADR-001 permission baseline. In particular, only owners manage membership/ownership and external sharing; managers may correct posted financial events with audit trails; staff have restricted operational access; viewer/accountant access is read-only. Enforcement resides in Fastify and business data queries, **not** in frontend button visibility.

## Alternatives considered

- **Email mandatory**: simpler standard invitation/recovery flows, but unnecessarily excludes WhatsApp-first merchants. Rejected.
- **WhatsApp sender number alone as login**: easy to misuse, fragile when numbers are reassigned, insufficient for high-sensitivity account actions. Rejected.
- **Custom identity system built from scratch**: more security-sensitive work and maintenance than an established library. Rejected.
- **Separate accounts per business**: duplicates identities and violates ADR-001. Rejected.
- **No mandatory secondary recovery for owners**: excessive risk for membership and financial-data management. Rejected.

## Expected implementation boundaries

- Account package/service with Better Auth + Phone Number + Organization + Drizzle, integrated into existing Fastify API and Next.js web app.
- Reviewed auth and invitation migrations, and business membership/permission policy tests.
- Registered-user phone OTP flow, optional email verification, business create/switch, owner recovery enrollment/step-up, and invitation flows.
- WhatsApp registration adapter on the **official** API only after integration approval and credentials are available; never claim an unconfigured integration works.
- Do not introduce financial tables, finance APIs, or Groq behavior under this ADR.
- Do not connect production users or send real OTPs until delivery, privacy, terms, account eligibility and deployment security have been reviewed.

## Required security tests

- Verified/unverified phone and email cases; placeholder email is not a recovery identity.
- Wrong, expired, duplicate, concurrent and rate-limited OTP attempts.
- Expired/replayed phone/email invitations; wrong recipient cannot accept.
- Business A user cannot access Business B without membership; switching businesses never transfers role.
- Staff cannot invite, change ownership or access another business's data.
- Last-owner protections, removal and role revocation apply immediately.
- Owner sensitive actions denied until recovery enrolled; denied after a stale (>10-minute) step-up; accepted only on valid recent proof.
- Browser session cannot exceed seven days even after active use; cookie/CSRF protections on sensitive routes.
- Signed versus spoofed WhatsApp webhooks; no account access from raw sender ID alone.
- No secrets, OTP values, recovery tokens or real personal data in logs or git.

## Dependencies and follow-up work

- **Delivery provider(s), Meta account eligibility/policies, deployment domains, detailed OTP transport, and precise recovery implementation** remain setup/implementation decisions. This ADR selects the security requirements, not any paid provider, live API credentials, or untested bypass.
- Financial schema, routes, workflow engine, and object storage are governed by later decisions.
- Read current vendor documentation when implementing, especially Better Auth Phone Number and Organization plugins, because their API details change.
