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

## Accepted auth design requirements (ADR-002)
- Better Auth on Neon via Drizzle is the intended identity store, with Phone Number and Organization plugins.
- User IDs are durable identifiers; verified phone and optional verified email are attributes, not business membership keys.
- Phone-only temporary email values, where required by the plugin, are synthetic, non-deliverable and never count as a verified email.
- Phone invitations require audited, expiring, single-use acceptance and custom recipient verification; email invitations follow Better Auth's verified-email pathway.
- Owner recovery enrollment and recent step-up must be enforceable before sensitive account changes.
- Model review must include uniqueness, concurrency, tenant isolation, revocation and auditability.

## Pending data design
- Exact Better Auth plugin-generated schema/migrations, organization membership and custom phone invitation schema details.
- Unique constraints, membership statuses and owner-transfer rules.
- Transaction, line item, payment, debt and stock-movement representation.
- Idempotency and correction events; money precision and inventory costing.
- Provenance and evidence statuses; reports and verification records.
- Database-level tenant guards and any row-level security strategy.

**Do not implement account or financial database migrations based solely on this worksheet.** Finalize the relevant ADR and reviewed schema first.
