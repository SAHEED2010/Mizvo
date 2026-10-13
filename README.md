# Mizvo

**Business clarity. Financial growth.**

Mizvo is a WhatsApp-first financial intelligence and growth application for Nigerian micro, small and medium businesses. Business owners and authorized staff will be able to record and understand purchases, sales, expenses, inventory, payments, debts and informal financial activities. The website will let them inspect, correct and download their records.

## Product direction

**Build a real, multi-business application.** The project is not limited to fictional accounts, a one-user proof of concept or a specific number of hackathon days. Development will be incremental; unfinished features must not be presented as complete.

- Each business has its own records, users and permissions.
- A user can own or work for multiple businesses with a different role in each.
- Owners can invite staff and manage their business access.
- An AI API interprets user messages and proposes drafts; deterministic application code validates and posts confirmed financial events.
- The intended conversational channel is the **official Meta WhatsApp Cloud API**, subject to its applicable terms and configuration. No simulated chat interface has been approved as a product feature.
- Financing-readiness guidance does not mean Mizvo provides, guarantees or approves loans.

## Repository state

**Requirements and architecture documentation exist; application code has not yet been scaffolded.** The first implementation task has been created as a GitHub issue. No live WhatsApp, banking, lender or AI integration is deployed yet.

## Documentation

- [AGENTS.md](AGENTS.md) — working rules for Codex and other coding agents
- [Product](docs/PRODUCT.md) — intended product capabilities and user groups
- [Architecture](docs/ARCHITECTURE.md) — components, trust boundaries and proposed repository structure
- [Technology stack](docs/TECH_STACK.md) — technology baseline and pending choices
- [AI architecture](docs/AI.md) — hosted provider, agent roles and confirmation boundary
- [Financial rules](docs/FINANCIAL_RULES.md) — accounting and evidence invariants
- [Data model](docs/DATABASE.md) — data design questions (not SQL schema)
- [Build plan](docs/BUILD_PLAN.md) — iterative milestones
- [Architecture decisions](docs/decisions/README.md) — accepted and proposed ADRs

## Architecture baseline

TypeScript, Next.js/React/Tailwind website, Fastify API, Neon PostgreSQL/Drizzle, Zod, Groq API candidate behind a replaceable adapter, and a deterministic financial engine. Use a pnpm monorepo, with Render as the initial hosting candidate.

**Accepted:** [ADR-001: Multi-business accounts, memberships and authorization](docs/decisions/001-multi-business-identity-and-access.md).

**Still pending:** authentication provider and methods, finalized permission implementation, data/ledger schema, API contracts, background jobs, files and deployment details.

## Engineering approach

Use one scoped task per branch/PR; review and test before merging. Do not commit API keys, customer financial data or credentials. Do not assume third-party WhatsApp or payment integrations are permitted or available without verifying their policies and configuration. Use synthetic data for automated tests, not as a substitute for the intended real multi-tenant product.
