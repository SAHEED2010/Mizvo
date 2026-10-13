# Mizvo — Instructions for Codex and coding agents

## Orientation
1. Read `README.md`, `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, `docs/TECH_STACK.md`, `docs/FINANCIAL_RULES.md` and `docs/BUILD_PLAN.md`.
2. Read **accepted** ADRs in `docs/decisions/`, especially ADR-001, before writing account or financial code.
3. Confirm the exact assigned task. For major changes, give a short plan; never silently select a technology or behavior not yet decided.
4. Work through reviewable branches and pull requests; do not implement unrelated features.

## Product scope
- Build Mizvo as a real, usable multi-business application, not as a fictional demo or single-user prototype.
- Users have separate identities and business-specific roles. One user may belong to several businesses; the same role must not apply globally.
- Initial roles: owner, manager, staff and viewer/accountant, with owner-managed membership.
- The intended messaging integration is the official Meta WhatsApp Cloud API. Do not implement a WhatsApp-style simulator or unofficial WhatsApp automation without an explicit new product decision.
- Do not claim live WhatsApp, lender partnerships, bank connections, guaranteed loans, external verification or measurable impact unless they actually exist.
- Incremental releases and testing may use synthetic data, but functionality should be architected for real authorized businesses.

## Architecture baseline (not all choices accepted)
- TypeScript; Next.js/React/Tailwind web; Fastify API; Neon PostgreSQL/Drizzle; Zod.
- Groq is the initial AI API candidate; keep provider code behind a replaceable adapter.
- One pnpm monorepo with modular services/packages. Avoid premature microservices and unnecessary infrastructure.
- Temporal, worker infrastructure, authentication implementation, final API routes and financial database schema are not yet approved; follow the task and ADR process.
- Financial calculations are deterministic and live outside UI and AI SDK modules.

## Account and authorization rules (ADR-001)
- All protected reads, writes, files, reports and AI requests must be authorized against the **active business membership** on the backend.
- Never trust a user-supplied `businessId` without checking that user's membership.
- Owners can invite/remove members and manage roles. Preserve at least one owner per business.
- Prevent cross-business leakage from shared queries, caches, jobs and files.
- Revoking a membership must stop future privileged access; record privileged membership changes in an audit history.
- A WhatsApp sender's phone number is not sufficient authentication to access a business.

## Financial integrity
- AI proposes structured drafts but **cannot directly post** financial records.
- Confirm uncertain inputs before posting. A confirmed posting must be validated, atomic, idempotent and auditable.
- Separate sales from payments and transfers; separate Ajo receipts from sales.
- Do not invent opening inventory or source evidence.
- Support corrections that preserve original history.
- Distinguish self-reported, internally reconciled, independently corroborated and unresolved information.
- Document integrity verification never proves every underlying business statement is true.
- Do not use unguarded floating point for currency.

## Engineering practices
- Do not commit credentials, real `.env` values, secrets, real voice files, receipts or personally identifiable customer data.
- Use business-scoped tests, including negative tests for role/tenant isolation.
- Validate untrusted inputs, model outputs and third-party webhooks.
- Never send real private financial data to AI services without explicit approval and an applicable privacy/security plan.
- Add automated tests and report **which tests actually ran**.
- For stack, schema and trust-boundary changes, add or update an ADR before implementation.
- No paid resource creation, public production launch, external financial-data transfer or connected account changes without explicit approval.

## Agent workflow
- Describe changes and affected packages first.
- Implement only the assigned issue.
- Open a PR with changed files, tests and risks.
- If there is an unanswered architecture choice, document it rather than assuming.
