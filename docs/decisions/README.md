# Architecture Decision Records (ADRs)

ADRs track binding decisions and their rationale. Proposed documents are not binding until explicitly approved.

## Accepted
- [ADR-001: Multi-business accounts, memberships and authorization](001-multi-business-identity-and-access.md) — **Accepted, 2026-10-13**. Users can belong to multiple businesses and have business-specific roles.
- [ADR-002: Phone-first authentication, business memberships, invitations and recovery](002-authentication-whatsapp-onboarding-and-recovery.md) — **Accepted, 2026-10-14**. Better Auth, optional email, verified WhatsApp/web onboarding, owner recovery and step-up.
- [ADR-004: Website phone OTP delivery boundary](004-phone-otp-sms-delivery.md) — **Accepted for the Phase B implementation boundary, 2026-10-14**. Africa's Talking adapter behind Better Auth; production activation is not approved.

## Proposed / to discuss
- ADR-003: Financial data semantics, numeric precision, inventory costing and corrections.
- Later: messaging, workflows, reports, storage, hosting and API contracts.

## Process
1. Copy `000-template.md` to a numbered file.
2. Document context, options, recommended decision and consequences.
3. Mark Proposed until the team approves; do not let Codex silently accept choices.
4. Add new ADR when replacing an accepted decision; do not delete history.
