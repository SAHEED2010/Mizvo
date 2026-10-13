# Technology stack — baseline and decision status

**Status:** Discussed baseline. Do not treat all entries as accepted ADRs.

| Area | Working choice | Current status / reasoning |
| --- | --- | --- |
| Repository | GitHub, pnpm workspaces | Proposed; convenient for two apps and shared TypeScript |
| Frontend | Next.js, React, TypeScript | Team's desired full-stack web UI; React is included in Next.js |
| CSS | Tailwind CSS | Proposed styling approach |
| Backend | Fastify on Node.js | Requested dedicated API to serve chat and web |
| Validation | Zod | Proposed runtime validation for external/AI outputs |
| Database | Neon PostgreSQL | Preferred managed PostgreSQL provider |
| ORM | Drizzle | Proposed migrations and typed database access |
| AI inference | GroqCloud API | Budget-conscious development candidate, subject to current quotas |
| AI model(s) | Configurable per task | Must benchmark speech, Nigerian amounts and language examples |
| Financial core | Own deterministic TypeScript code | Essential product logic; no LLM as ledger |
| Messaging | Meta WhatsApp Cloud API | Conditional on approved service use; simulator fallback |
| Hosting | Render | Initial choice for demo; free-tier sleep/limits require rehearsal |
| Background jobs | None initially | Add a durable queue/worker or Temporal only if needed |
| Automated tests | Vitest | Proposed for calculation/integration tests |
| End-to-end tests | Playwright | Optional if time permits |
| Object storage | Undecided | Needed only when documents are in scope |
| Authentication | Undecided | Critical choice based on demo scope and access boundaries |
| PDF generator | Undecided | Select when reports are specified |

## Cost control
- Use fictional sample data and local runs before deploying anything.
- Provider credentials must stay server-side and out of GitHub.
- An AI API is not a free unlimited resource; document usage limits and error fallback.
- Do not depend on production reliability from free hosting tiers.

## ADRs still needed
1. Exact first-demo scope and account model.
2. Financial-event entities and accounting conventions.
3. Authentication/authorization approach.
4. AI output contract and provider/model benchmark.
5. Reports, evidence states and persistence.
6. API endpoint contract and deployment environment.
