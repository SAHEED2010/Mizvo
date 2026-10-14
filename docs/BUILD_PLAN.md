# Mizvo — Iterative build plan

**Goal:** Build a usable, account-based financial intelligence application for multiple independent businesses. Hackathon presentations may highlight current capabilities, but the product is not an artificial demo or restricted to a three-day development window.

## Agreed priorities
- Create a sound TypeScript monorepo with Next.js website and Fastify API.
- Support secure user identity and independent business memberships (ADR-001).
- One user may own or work in multiple businesses with different roles.
- All financial and AI requests must respect business boundaries.
- Connect official WhatsApp through approved configuration and policy review, not an unofficial or imitation client.
- Keep the financial engine deterministic and reports transparent about evidence status.

## Immediate engineering milestones
1. **Repository scaffold:** pnpm workspace, Next.js/TypeScript/Tailwind web and Fastify/TypeScript API; no premature auth or financial endpoints.
2. **Account/auth decision (accepted):** ADR-002 selects Better Auth, phone-first website/official WhatsApp onboarding, optional email, verified invitations, secure sessions and recovery requirements.
3. **Business membership foundation — Build 002:** Phase A (Better Auth/Drizzle schema and business authorization foundation) is merged. Phase B implements website phone OTP delivery and seven-day browser sessions behind a provider adapter; ADR-004's vendor and delivery boundary remain proposed pending explicit approval. Business memberships, owner recovery enrollment, step-up checks and audited invitations remain follow-up phases. External OTP delivery stays disabled until its sender and credentials are approved and configured.
4. **Financial model decision:** define purchases, sales, payments, inventory, Ajo and corrections before coding ledger.
5. **Core finance:** implement deterministic rules with idempotency and tenant isolation.
6. **AI parsing:** consume Groq-hosted API behind a provider adapter; validate proposals and obtain confirmation.
7. **WhatsApp:** connect the official service if integration eligibility and configuration are approved.
8. **Website and reports:** operational views, authorized corrections and downloadable evidence-labeled documents.
9. **Financing readiness:** requirements and illustrative scenarios; do not claim lender acceptance.
10. **Operational readiness:** security, data protection, deployments, access control, monitoring and tests.

## Implementation rules
- One scoped issue and reviewable PR at a time; never require completing every design topic before beginning infrastructure scaffolding.
- Explicitly track which features work and which are planned.
- Use generated/synthetic data for automated tests while designing the application for real authorized users.
- Do not create production customer accounts or process their information until privacy and security requirements are in place.
- Do not claim external integrations are live until verified.

## What counts as progress
- Repo builds and lints.
- API and web can run locally.
- Multi-business isolation tests pass once accounts are implemented.
- Transaction posting is atomic, reversible through audited correction and deduplicated.
- AI cannot bypass confirmation or permission checks.
