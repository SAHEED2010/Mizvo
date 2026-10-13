# Technology baseline — living decisions

The stack below represents the **team's current preferred build direction**. Exact dependency versions and service configuration will be selected during implementation. **ADR-001 and ADR-002 are formally accepted**. Other stack details remain proposals.

| Layer | Preferred choice | Purpose |
| --- | --- | --- |
| Monorepo | pnpm workspaces | Shared TypeScript packages; independent web/API apps |
| Frontend | Next.js + React + TypeScript | Website routes, components, business dashboards |
| UI styling | Tailwind CSS | Responsive Mizvo-branded interface |
| Backend | Node.js + Fastify | APIs, business authorization, external integrations |
| Validation | Zod | Structured input and model-output validation |
| Database | Neon PostgreSQL | Persistent records for multiple businesses |
| ORM | Drizzle | SQL queries, migrations, typed schemas |
| Authentication | **Better Auth + Phone Number + Organization plugins** | Accepted ADR-002: web/official WhatsApp onboarding, phone-first, optional verified email and secure sessions |
| AI | Groq API initial candidate | Hosted language / audio models, no model training required |
| AI integration | Replaceable provider adapter | Provider switching and explicit task contracts |
| Financial logic | Custom TypeScript modules | Deterministic calculations, reconciliation and evidence handling |
| WhatsApp | Official Meta WhatsApp Cloud API | Planned messaging integration, subject to actual policy eligibility |
| Background tasks | Not finalized | Decide once workload and hosting constraints are clearer |
| Hosting | Render candidate | Deployment option, not a requirement |
| Documents | Not finalized | Private object storage and report generation decisions pending |
| Testing | Vitest, integration tests | Math, data integrity, tenant isolation, authorization |

## Current architecture guardrails
- Build a usable application for multiple separate businesses, not a one-business hackathon imitation.
- Do not write unapproved auth schemas, route names or service integrations into generated code.
- Development milestones should be small, but there is no arbitrary three-day lifespan.
- Keep AI extraction separate from trusted financial posting.
- Use official WhatsApp integration only when permitted and properly configured.

## Decisions to make next
- Implement ADR-002: signed-in phone identities, recovery enrollment, staff invitations, verified messaging adapter and tenant permission tests.
- Financial data model and accounting conventions (ADR-003).
- Message/transaction confirmation lifecycle and first API contracts.
- Job orchestration, file storage and deployment.
