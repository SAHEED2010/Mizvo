# Authentication foundation (Phase A)

## Implemented

- Better Auth is configured in the Fastify API with the Drizzle adapter and PostgreSQL schema.
- The Phone Number plugin uses five-minute OTPs, three allowed attempts, verified-phone requirements, and a non-deliverable `users.invalid` placeholder for phone-only identities.
- OTP delivery intentionally throws until an approved provider is configured. No OTP, registration or login request can succeed through an unconfigured delivery path.
- The Organization plugin is the canonical source of business membership and supports only owner, manager, staff and viewer roles. Organization creation is disabled in this phase.
- API helpers obtain identity from a verified Better Auth session and read membership from the Organization-backed `member` table for the explicitly requested business.
- The Drizzle schema and migrations were generated from Better Auth's configured plugins. Migrations add a unique user/business membership, constrain roles to the approved single-role set, and serialize owner removals/demotions so a business cannot lose its last owner under concurrent updates.
- `AUTH_ENABLED` defaults to `false`; auth routes are not registered unless explicitly enabled.

## Not enabled in Phase A

Website sign-in UX and its delivery provider, business onboarding, invitation delivery/acceptance, recovery enrollment, step-up checks, WhatsApp integration, financial routes, and production account creation are separate phases. Do not enable auth routes for real users until OTP delivery, rate limits, origin/CSRF controls, session lifetime, recovery and operational monitoring have been configured and reviewed.

## Local setup

1. Use Node.js 22+ and pnpm 11.11.0.
2. Copy `.env.example` to `.env` and set a development-only PostgreSQL `DATABASE_URL` and a random `BETTER_AUTH_SECRET` of at least 32 characters.
3. Leave `AUTH_ENABLED=false` unless working on a specifically reviewed auth integration task. The default OTP sender rejects requests; do not replace it with a logging or echo sender.
4. Generate schemas and migrations with the database package scripts, review the diff, and run migrations only against an explicitly selected development database.
5. Do not put real secrets, phone numbers, business records or customer information in source control or logs.
