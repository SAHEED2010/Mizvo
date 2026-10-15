# Architecture Decision Records (ADRs)

ADRs track binding decisions and their rationale. Proposed documents are not binding until explicitly approved.

## Accepted
- [ADR-001: Multi-business accounts, memberships and authorization](001-multi-business-identity-and-access.md) — **Accepted, 2026-10-13**. Users can belong to multiple businesses and have business-specific roles.
- [ADR-002: Phone-first authentication, business memberships, invitations and recovery](002-authentication-whatsapp-onboarding-and-recovery.md) — **Accepted, 2026-10-14**. Better Auth, optional email, verified WhatsApp/web onboarding, owner recovery and step-up.

## Proposed / to discuss
- ADR-003: Financial data semantics, numeric precision, inventory costing and corrections.
- Later: messaging, workflows, reports, storage, hosting and API contracts.
- [ADR-004: Website phone OTP delivery boundary](004-phone-otp-sms-delivery.md) — **Proposed, 2026-10-14**. Recommends a provider-neutral SMS adapter with Africa's Talking as the Phase B candidate; pending explicit team approval.
- [ADR-005: Verified business creation and active business context](005-business-onboarding-and-active-business.md) — **Proposed for Phase C1, 2026-10-14**. Server-only Organization operations, atomic verified-owner bootstrap, and membership revalidation for active business reads.
- [ADR-007: Guarded phone-only business invitations](007-phone-only-business-invitations.md) — **Proposed for Phase C2, 2026-10-15**. Separate hashed phone-invitation lifecycle, Better Auth membership authority, audit trail, and default-deny C3 security gate.

## Process
1. Copy `000-template.md` to a numbered file.
2. Document context, options, recommended decision and consequences.
3. Mark Proposed until the team approves; do not let Codex silently accept choices.
4. Add new ADR when replacing an accepted decision; do not delete history.
