# Authentication foundation (Phase A)

## Implemented

- Better Auth is configured in the Fastify API with the Drizzle adapter and PostgreSQL schema.
- The Phone Number plugin uses five-minute OTPs, three allowed attempts, verified-phone requirements, and a non-deliverable `users.invalid` placeholder for phone-only identities.
- OTP delivery intentionally throws until an approved provider is configured. No OTP, registration or login request can succeed through an unconfigured delivery path.
- The Organization plugin is the canonical source of business membership and supports only owner, manager, staff and viewer roles. The built-in `member` default is removed, membership creation requires an explicit role, and organization creation is disabled in this phase.
- Organization server-side member creation and invitation hooks reject missing, built-in, multi-role, or otherwise unsupported roles; the database role check remains the final membership guard when invitations are accepted.
- API helpers obtain identity from a verified Better Auth session and read membership from the Organization-backed `member` table for the explicitly requested business.
- The Drizzle schema and migrations were generated from Better Auth's configured plugins. `db:auth-schema` runs a checked augmentation script to retain Mizvo's membership uniqueness and role check constraints after generation. Migrations serialize owner removal, demotion, and moves from an organization so a business cannot lose its last owner under concurrent updates.
- Business/organization deletion is unsupported in Phase A. The owner guard intentionally rejects a cascading deletion that would remove the final owner. Before business deletion is enabled, design an explicit reviewed teardown path and integration test rather than bypassing the guard.
- `AUTH_ENABLED` defaults to `false`; auth routes are not registered unless explicitly enabled.

## Not enabled in Phase A

Website sign-in UX and its delivery provider, business onboarding, invitation delivery/acceptance, recovery enrollment, step-up checks, WhatsApp integration, financial routes, and production account creation are separate phases. Do not enable auth routes for real users until OTP delivery, rate limits, origin/CSRF controls, session lifetime, recovery and operational monitoring have been configured and reviewed.

## Local setup

1. Use Node.js 22+ and pnpm 11.11.0.
2. Copy `.env.example` to `.env` and set a development-only PostgreSQL `DATABASE_URL` and a random `BETTER_AUTH_SECRET` of at least 32 characters.
3. Leave `AUTH_ENABLED=false` unless working on a specifically reviewed auth integration task. The default OTP sender rejects requests; do not replace it with a logging or echo sender.
4. Generate schemas and migrations with the database package scripts, review the diff (including the custom augmentation), and run migrations only against an explicitly selected development database. `pnpm db:auth-schema` preserves Mizvo's unique membership index and role check and fails if Better Auth changes the generated member table shape.
5. Run `pnpm test:postgres` only with the isolated local database named `mizvo_test`; the integration suite refuses non-local or differently named database URLs. CI uses an ephemeral PostgreSQL 16 service.
6. Do not put real secrets, phone numbers, business records or customer information in source control or logs.
