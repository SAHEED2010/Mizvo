# Mizvo

**Business clarity. Financial growth.**

Mizvo is a proposed WhatsApp-first financial intelligence and growth platform for Nigerian micro, small and medium businesses. Owners describe business activity by text or voice, review interpreted transactions, and use a web dashboard to inspect records and prepare financial reports.

## Current objective

Build a **hackathon demonstration**, not a production banking or lending service. The demo should show one complete and explainable journey:

1. A merchant records a purchase or sale through a conversational interface.
2. An AI provider proposes structured information from the message.
3. The merchant clarifies or confirms the proposed details.
4. Mizvo's deterministic financial engine posts the confirmed event.
5. The website displays financial and inventory changes.
6. A report distinguishes self-reported data from independently supported evidence.
7. A financing-readiness example explains documentation needs without promising credit.

The WhatsApp-style simulator is the fallback until actual WhatsApp integration is permitted and configured.

## Repository status

**Documentation scaffold only. Application code has not yet been built.** This repository deliberately leaves open design decisions for team review before implementation by Codex or developers.

## Start here

- [AGENTS.md](AGENTS.md) — development and AI coding-agent rules
- [Product](docs/PRODUCT.md) — users, product boundaries, demo journey
- [Architecture](docs/ARCHITECTURE.md) — proposed components and repository layout
- [Technology stack](docs/TECH_STACK.md) — selected baseline and open questions
- [AI design](docs/AI.md) — hosted AI usage and agent-module boundaries
- [Financial rules](docs/FINANCIAL_RULES.md) — accounting and evidence invariants
- [Data model](docs/DATABASE.md) — entities to design; not a migration
- [API contracts](docs/API_CONTRACTS.md) — interfaces to specify
- [Build plan](docs/BUILD_PLAN.md) — task sequencing and demo acceptance
- [Architecture decisions](docs/decisions/README.md) — ADR process and template

## Current proposed direction

TypeScript, Next.js + React + Tailwind for the web, Fastify for the API, Neon PostgreSQL + Drizzle, Zod validation, Groq-hosted AI behind a replaceable provider interface, and our own financial engine. pnpm monorepo and Render hosting are the default plan. **These are planning choices, not proof that services are deployed.** Other decisions remain open.

## Safety and accuracy

Use synthetic demonstration data. Never commit credentials or real customer documents. AI must not post transactions directly or invent financial evidence. Reports should distinguish document authenticity from verification of underlying transactions. Mizvo does not issue, guarantee, or approve loans.

## Development workflow

Discuss and document important decisions first, then implement one scoped GitHub issue/PR at a time. Keep changes testable, reviewable and aligned with `AGENTS.md`.
