# ADR-001: Multi-business accounts, memberships and authorization

- **Status:** Accepted
- **Date:** 2026-10-13
- **Decision owners:** Mizvo team
- **Scope:** Product identity, business tenancy and authorization principles; not a final authentication-provider choice

## Context

Mizvo is intended to be a usable application for multiple independent businesses, not a single-business or fictional demonstration. Business owners and staff require separate accounts, and one person may own or work for more than one business without needing a second login. The same user may have different privileges in different businesses.

## Decision

1. **Multi-tenant application.** Multiple independent businesses operate in one application with logical data isolation. A shared PostgreSQL database is acceptable; do not require a separate database per business.
2. **One user identity, many memberships.** A user may belong to zero or more businesses. A user's role is attached to their **membership in a particular business**, never to their global user identity.
3. **Owner and staff accounts.** Each business has at least one owner. Initial role model: **owner**, **manager**, **staff**, **viewer/accountant**. These roles are business-specific.
4. **Business selection.** An authorized user can switch between businesses they belong to. Every business operation runs in an explicitly authorized business context; do not trust a client-provided business ID without checking membership.
5. **Backend authorization.** The API enforces role and business permissions for every protected read, write, report, file and AI request. Hiding a frontend button does not authorize an operation.
6. **Owner-controlled membership.** Owners can invite or remove members, assign roles and control external sharing. Invitations must require appropriate recipient verification and should support expiry/revocation.
7. **Protected ownership.** A business must retain at least one owner; prevent the last owner from leaving, being removed or being demoted without a valid ownership transfer.
8. **Auditability.** Track invitations, membership and role changes, sensitive access, and financial corrections. Never silently erase financial history.
9. **Cross-business safety.** A user who is staff in business A and owner in business B has owner privileges **only** in B. All queries and storage access must preserve that isolation.
10. **WhatsApp accounts.** A messaging phone number alone does not prove business membership or grant access. Linking must be verified and authorized separately.

## Initial role permissions (baseline for implementation; refine during API design)

| Action | Owner | Manager | Staff | Viewer / accountant |
| --- | --- | --- | --- | --- |
| Read full authorized financial dashboards/reports | Yes | Yes | Only assigned operational records | Yes, read-only |
| Record permitted sales, purchases and expenses | Yes | Yes | Yes, assigned operations | No |
| Confirm own valid transaction drafts | Yes | Yes | Yes, assigned operations | No |
| Manage inventory | Yes | Yes | Limited to permitted operations | No |
| Correct already-posted transactions | Yes, audited | Yes, audited | Request only | No |
| Invite, remove or re-role members | Yes | No | No | No |
| Manage ownership and business settings | Yes | No | No | No |
| Share financial reports externally | Yes | No | No | No |

This table is the **starting access policy**; permissions that need finer granularity (e.g. staff assigned records) should be specified in the next permissions design. Never implement broad staff access by default.

## Recommended relational shape (logical only, not a database migration)

- `users`: global identities.
- `businesses`: independent business accounts.
- `business_memberships`: `user_id`, `business_id`, `role`, `status`, timestamps; prevent duplicate active memberships.
- `business_invitations`: business, invited address, proposed role, expiration, inviter and acceptance state.
- `audit_events`: business-scoped administrative and financial actions.

Detailed table names, foreign keys, invitation token handling and session implementation will be finalized in the database/auth specification, not inferred from these examples.

## Consequences and security tests

- Test different owners cannot see or change each other's financial data even by guessing identifiers.
- Test one user can switch between their businesses and cannot carry permissions across them.
- Test staff cannot invite users, change roles or access unaffiliated businesses.
- Test an invited member joins only the intended business and only after acceptance.
- Test the last owner cannot be removed or demoted.
- Test membership revocation invalidates further access, including AI and file requests.
- Test all privileged membership operations leave an audit trail.

## Explicitly NOT decided by this ADR

- Whether to use Better Auth, Neon Auth or another authentication library.
- Final sign-in method (email/password, magic link, OAuth, etc.) and invitation delivery method.
- Exact row-level security policy, session/cookie handling, deployment credentials or WhatsApp linking flow.
- Detailed route names, SQL tables and financial ledger event model.

Those require separate decisions or specification. Do not make them up just to get an implementation running.
