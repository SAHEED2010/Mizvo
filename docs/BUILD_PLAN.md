# Hackathon build plan — preliminary

**Goal:** demonstrate a working end-to-end financial-evidence journey. Not a production lender platform.

## Before Codex implements application code
1. Review team/contest constraints, initial demo scope and whether a single seeded business is enough.
2. Accept ADRs for transaction semantics, account model, AI schema and initial endpoints.
3. Define financial acceptance tests using synthetic examples.
4. Divide work with clear ownership between frontend, backend, AI and research.
5. Confirm whether a live WhatsApp integration is policy-permitted; retain chat simulator fallback.

## Proposed implementation sequence
- **Foundation:** pnpm workspace; Next.js frontend and Fastify backend; shared Zod schemas; Neon/Drizzle setup.
- **Financial core:** purchases, sales, partial payments, stock movements, corrections and deduplication with tests.
- **AI adapter:** Groq provider and structured extraction of **draft** transactions.
- **Confirmation:** user reviews proposed records; deterministic code performs posting.
- **Dashboard:** transactions, stock and owed amounts using backend data.
- **Report:** simple downloadable financial summary showing limitations/evidence sources.
- **Financing demo:** readiness checklist with *illustrative*, not live, product criteria.
- **Deploy and rehearse:** Render and a locally recorded fallback in case of network problems.

## Three-day illustrative schedule (not a promise)
- Day 1: contracts, workspace, database, financial core.
- Day 2: AI extraction, confirmation, dashboard wiring.
- Day 3: reports, financing readiness, testing, deployment.
- Day 4: presentation, rehearsals and demo.

Scope should be reduced if core flow is unstable. Voice and receipts are stretch goals. WhatsApp must be clearly labeled simulated if it is not a live official integration.

## Acceptance criteria for first complete demo
- Confirmed sample purchase/sale updates database and dashboard exactly once.
- AI error can be corrected before posting.
- Partial payment does not change recorded sales value.
- Ajo payout is not treated as sales revenue.
- Missing opening stock is not fabricated.
- Report identifies self-reported information.
- Demo contains no real personal or financial data.
- Every team member can explain their module and known limitations.

## Next documentation tasks
Finalize `DATABASE.md`, `API_CONTRACTS.md` and acceptance tests *after* team decisions. Then assign Codex small scoped implementation tasks, one pull request at a time.
