# ADR-005: Verified business creation and active business context

- **Status:** Proposed for Build 002 Phase C1
- **Date:** 2026-10-14
- **Decision owners:** Mizvo team
- **Depends on:** [ADR-001: Multi-business accounts and authorization](001-multi-business-identity-and-access.md), [ADR-002: Phone-first authentication](002-authentication-whatsapp-onboarding-and-recovery.md)

## Context

Phase C1 needs a safe first business for a verified account and a way for one identity to switch between memberships. The accepted Organization plugin remains the canonical organization and membership store. Its browser-facing API includes additional owner actions that Phase C2/C3 have not secured with independent recovery and recent step-up.

## Proposal

1. A Fastify business API uses the Better Auth Organization plugin on the server. Direct browser requests to Organization plugin endpoints stay blocked; only server-controlled C1 operations are exposed.
2. Creation requires an authenticated session whose `phoneNumberVerified` value is true. Better Auth creates the organization and its creator membership with the `owner` role inside a Drizzle transaction. The request does not accept a user ID, role, slug, active organization or owner claim.
3. Generate a stable account-scoped slug from the normalized business name and a hash of the authenticated internal user ID. This makes repeated same-name create requests for that identity collide safely at the Organization slug uniqueness constraint. It is an identifier only; it never grants or infers membership.
4. Read the current user's organization memberships from PostgreSQL for listing and each business-scoped operation. Selecting an organization updates Better Auth's server-side `activeOrganizationId`; it is a UI preference and must be checked against a fresh membership row before any protected business data is returned.
5. The website persists only the active selection held by the Better Auth session. It never treats browser storage or the selected ID as authorization.
6. C1 adds no business profile or financial schema. Organization name is the only business detail collected. Business deletion, invites, membership changes, recovery and step-up stay unavailable until their own reviewed stages.

## Consequences

- Parallel repeated creation cannot leave an organization without its single owner membership or create duplicate same-name businesses for the same account.
- Database membership is re-read on list, active selection and active-business reads, so revocation and role changes take effect on the next request.
- This proposal does not approve production registration or any SMS provider. Delivery integration and security approval remain prerequisites.
- Phase C2/C3 must explicitly add protected owner actions after independent recovery and fresh step-up checks are implemented.

## Alternatives considered

- Trusting a browser organization ID or cookie alone: rejected because it can preserve stale or cross-business access.
- Enabling all Organization plugin routes for the browser: rejected because membership changes/invitations are not yet protected by C2/C3 recovery and step-up gates.
- Writing a separate business or membership table: rejected because it would duplicate the Organization plugin's canonical source of truth.

## Review scope

This ADR records the C1 implementation proposal. It does not select a financial schema, invitation flow, recovery method, business deletion process or public SMS provider.
