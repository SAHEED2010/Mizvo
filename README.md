# Mizvo

**Business clarity. Financial growth.**

Mizvo is a WhatsApp-first financial intelligence and growth application for Nigerian micro, small and medium businesses. The project is being built for real, independent businesses with business-specific access; unfinished features are not presented as complete.

## Product direction

- Each business has its own records, users and permissions.
- One user can belong to multiple businesses with a different role in each.
- Owners manage access to their businesses.
- AI may propose structured records; deterministic application code validates and posts only confirmed financial events.
- The intended messaging channel is the official Meta WhatsApp Cloud API, subject to its policies and configuration. No simulated chat feature is approved.
- Financing-readiness guidance does not mean Mizvo provides, guarantees or approves loans.

## Repository status

The pnpm TypeScript monorepo contains a Next.js website and Fastify API. Phase A added Better Auth, Drizzle/Neon schema and business authorization foundations. Phase B adds website phone OTP sign-in behind a provider-neutral adapter; delivery defaults to disabled, and authentication remains disabled until the deployment is configured and reviewed. Africa's Talking is an optional adapter, not an approved provider; restricted delivery integration testing must pass before public registration. Business setup, recovery enrollment, invitations, financial data, AI and WhatsApp onboarding are future phases.
Phase C1 is implementing verified business creation and business switching behind a draft PR. Invitations and recovery/step-up remain separately reviewed later stages; financial data, AI and WhatsApp onboarding are future phases.

## Requirements

- Node.js 22 or newer
- pnpm 11.11.0 (managed through Corepack)

## Local development

```sh
corepack enable
pnpm install
pnpm dev
```

The web app is at http://localhost:3000. The API listens at http://localhost:4000 by default; `GET /health` returns `{ "status": "ok" }`.

Useful commands:

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm format
```

`pnpm test` builds workspace dependencies and runs API tests, including the PostgreSQL suite when `DATABASE_URL` points to the isolated local `mizvo_test` database. `pnpm format` applies Biome formatting; `pnpm lint` checks formatting and lint rules without changing files.

## Environment

The API reads `HOST` and `PORT` from the process environment. `.env.example` lists blank, server-only provider placeholders. See [phone authentication setup](docs/AUTHENTICATION.md) before enabling auth. Africa's Talking is **not production ready** until account eligibility, Nigerian sender ID approval, pricing and delivery terms, and working credentials have been confirmed. Never use real customer data in local development.

Database commands (run after supplying a development-only `DATABASE_URL`):

```sh
pnpm --filter @mizvo/database db:auth-schema
pnpm --filter @mizvo/database db:generate
pnpm --filter @mizvo/database db:migrate
```

The auth schema command uses Better Auth's pinned CLI to regenerate the tables from the server plugin configuration. Review generated output before migration. The committed migrations include Mizvo's single-role membership and last-owner constraints.

## Workspace layout

- `apps/web` — Next.js, React, TypeScript and Tailwind CSS
- `apps/api` — Fastify, TypeScript and the public health check
- `packages/shared-types` — reusable TypeScript contracts
- `packages/shared-schemas` — reusable Zod schemas
- `packages/financial-core`, `packages/database`, `packages/ai` — reserved package boundaries with no business logic or provider decisions yet

## Documentation

- [Agent instructions](AGENTS.md)
- [Product](docs/PRODUCT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Technology stack](docs/TECH_STACK.md)
- [AI architecture](docs/AI.md)
- [Financial rules](docs/FINANCIAL_RULES.md)
- [Data model questions](docs/DATABASE.md)
- [Build plan](docs/BUILD_PLAN.md)
- [Architecture decisions](docs/decisions/README.md)

Accepted: [ADR-001](docs/decisions/001-multi-business-identity-and-access.md) (multi-business access) and [ADR-002](docs/decisions/002-authentication-whatsapp-onboarding-and-recovery.md) (Better Auth, phone-first registration, invitations and recovery). [ADR-004](docs/decisions/004-phone-otp-sms-delivery.md) remains proposed pending explicit team approval; it recommends provider-neutral delivery and identifies Africa's Talking as the first optional adapter, with public registration gated on integration testing and approval. [ADR-005](docs/decisions/005-business-onboarding-and-active-business.md) records the proposed C1 implementation. Invitations, recovery/step-up, WhatsApp, the financial model, jobs and file workflows remain pending.
