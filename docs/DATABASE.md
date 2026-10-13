# Data modeling — principles and open decisions

**Status:** Database design **not finalized**. This is not a migration or approved SQL schema.

## Accepted identity and tenant invariants (ADR-001)
- Independent businesses share managed PostgreSQL infrastructure.
- A user identity may be a member of multiple businesses with different roles.
- At least one owner must remain for each active business.
- Business-scoped records must never be accessed across unauthorized memberships.
- Member invitations, role changes and revocations require auditability.
- An active business identity is not sufficient authorization by itself: every request must be checked against the authenticated user.

## Likely identity entities (logical, not final table definitions)
- Users, businesses, business memberships, invitations, administrative audit events.
- Business-specific financial tables will reference the correct business/tenant.

## Pending data design
- How authentication sessions and invitation tokens will be represented.
- Unique constraints, membership statuses and owner-transfer rules.
- Transaction, line item, payment, debt and stock-movement representation.
- Idempotency and correction events; money precision and inventory costing.
- Provenance and evidence statuses; reports and verification records.
- Database-level tenant guards and any row-level security strategy.

**Do not implement account or financial database migrations based solely on this worksheet.** Finalize the relevant ADR and reviewed schema first.
