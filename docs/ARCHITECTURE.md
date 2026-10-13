# Architecture — baseline and accepted boundaries

## Agreed operating model
A **pnpm TypeScript monorepo** is the intended code organization. The website uses Next.js/React; a dedicated Fastify API will handle authenticated business operations and third-party integration adapters. Financial logic lives in independent modules. Database provider preference: Neon PostgreSQL with Drizzle.

**ADR-001 and ADR-002 are accepted:** the application is multi-tenant; identities use Better Auth's Phone Number and Organization plugins, with owner/staff memberships, phone-first website and authorized WhatsApp registration, optional email and secure recovery.

## Intended request flow

```text
Official WhatsApp Business Platform (when approved/configured)
              │
              ▼
       Fastify backend  ◄────►  Next.js website
              │                   (authorized browser user)
              ▼
     Authorized business context
              │
              ▼
    AI provider adapter (Groq candidate)
              │
              ▼
       Validated record draft
              │
              ▼
     Clarification / confirmation
              │
              ▼
   Deterministic financial engine
              │
              ▼
  Neon PostgreSQL + audit history
              │
              ▼
     Reports / business dashboard
```

The API must verify business membership for all privileged operations, including AI lookups. Better Auth manages identity and sessions, and the Organization plugin manages membership; Fastify performs business-level authorization. Phone-first WhatsApp onboarding must use a verified official integration, never trust the sender number alone. Owners need a secondary recovery method before sensitive account management. Messages from third-party sources are untrusted until validated, authenticated and linked to the appropriate business.

## Proposed package structure (to be scaffolded through a reviewed task)

```text
mizvo/
  AGENTS.md
  apps/
    web/                       # Next.js / React / TypeScript
    api/                       # Fastify and authorized API integrations
  packages/
    ai/
      src/
        agents/
          intent.agent.ts
          transaction.agent.ts
          clarification.agent.ts
          insights.agent.ts
        providers/
          groq.provider.ts
        orchestrator.ts
    financial-core/
      src/
        sales.ts
        purchases.ts
        inventory.ts
        payments.ts
        reconciliation.ts
    database/
      schema/
      migrations/
    shared/
      schemas/
      types/
    reports/
  docs/
  tests/
  pnpm-workspace.yaml
```

AI agent names describe **task responsibilities**, not separate autonomous models or mandatory additional provider calls. Prefer clear testable modules.

## Architectural constraints
- Do not use separate databases per business without a further decision.
- Do not rely solely on frontend filtering; enforce tenant and role permissions in the backend and suitable database policies.
- Use idempotency and database transactions to prevent duplicate or partially applied financial postings.
- Avoid a model's direct write access to posted financial records.
- Do not commit to Temporal, a job queue, storage provider, or precise API endpoints before their respective decisions.
- Integrate WhatsApp via authorized official APIs only; there is no approved simulator feature.
- Treat multi-tenant auth, sessions, data isolation and provider privacy as security-critical.

## Further design needed
The auth implementation must satisfy ADR-002 (including secure phone-only invitations, step-up authentication and owner recovery). Database schema details, transaction semantics, route contracts, report integrity/storage, background processing, and deployment topology remain to design.
