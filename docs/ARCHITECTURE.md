# Architecture — proposed, not implemented

## Operating model
A single TypeScript **pnpm monorepo** containing a Next.js website, Fastify API and reusable libraries. This is a **modular backend**, not a microservices system.

```text
Owner → WhatsApp (if permitted) or labeled chat simulator
      → Fastify API / message adapter
      → AI adapter (Groq-hosted model) → validated transaction draft
      → user clarification / confirmation
      → deterministic financial engine
      → Neon PostgreSQL + audit history
      → Next.js website and downloadable evidence-labeled reports
```

The website and chat share business data and access controls. Direct monetary calculations never rely on an LLM response.

## Proposed source layout, to create after approval
```text
mizvo/
  AGENTS.md
  apps/
    web/                  # Next.js + React + TypeScript
    api/                  # Fastify routes, authorization, integrations
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
        prompts/
    financial-core/
      src/
        sales.ts
        purchases.ts
        payments.ts
        inventory.ts
        reconciliation.ts
        financing.ts
    database/
      schema/
      migrations/
    shared/
      schemas/
      types/
    reports/
  tests/
  docs/
  pnpm-workspace.yaml
```

Agent modules describe **responsibilities**, not a requirement to spawn multiple independent agents. One model call may cover multiple tasks; each output still requires schema validation and confirmation.

## Components
- **Web:** business dashboard, record review/correction, reports; no website voice feature required.
- **API:** authenticated business boundaries, request validation, transaction application, WhatsApp webhook adapter if permitted.
- **AI:** external text/audio/image services behind an interchangeable adapter; proposes data but does not post it.
- **Financial core:** pure TypeScript functions, deterministic calculations, reconciliation, idempotency.
- **Database:** structured business records, evidence metadata, corrections and traceable histories.
- **Report module:** documents disclose source/verification limitations.
- **Background processing:** **deferred** for initial demo unless a long-running task requires it. Do not imply that a reliable workflow engine has been deployed.
- **WhatsApp:** integration conditional on current service eligibility and policies; a local simulator is an explicitly named fallback.

## Trust boundaries and failure cases
- Untrusted messages and uploaded documents must not become agent instructions.
- Validate incoming webhooks and deduplicate message IDs where applicable.
- Scope every database read/write by an authorized business.
- Save only confirmed events; retain drafts and corrections separately.
- A failed AI call must not corrupt committed financial data.
- Hosted model availability, slow startup on free hosting and network outages require demo fallbacks.

## Open design questions
Authentication, session strategy, multi-tenant data isolation, schema details, API payloads, inventory valuation, money precision, report format and jobs are not finalized. Record final choices in ADRs before Codex builds them.
