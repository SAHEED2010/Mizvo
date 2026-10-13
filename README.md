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

The first application scaffold contains a Next.js web app and a Fastify API in a pnpm TypeScript monorepo. The API exposes only a public health check. Authentication, business membership flows, financial data, AI, WhatsApp and database integrations remain future work and require their own decisions.

## Requirements

- Node.js 20.9 or newer
- pnpm 10 or newer (Corepack is recommended)

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

`pnpm test` builds workspace dependencies and runs the API health-check smoke test. `pnpm format` applies Biome formatting; `pnpm lint` checks formatting and lint rules without changing files.

## Environment

The API reads `HOST` and `PORT` from the process environment. `.env.example` lists the current defaults; no credentials or external services are needed for the scaffold.

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

Only [ADR-001](docs/decisions/001-multi-business-identity-and-access.md) is accepted. Authentication provider and methods, data/ledger schema, API contracts, jobs, files and deployment details remain pending.
