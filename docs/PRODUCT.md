# Product brief — Mizvo

**Status:** Living product specification for an application intended for real business users.

## Problem
Many Nigerian SMEs keep business information across cash, bank/POS payments, receipts, stock notes, customer and supplier debts and informal savings. This can obscure business performance and hinder financing preparation.

## Product
Mizvo is a WhatsApp-first financial intelligence and growth platform. With official WhatsApp integration, authorized business members will describe activity via text and voice notes and may provide supporting documents. The backend interprets information, requests clarification and records confirmed financial events. A website will support viewing, updating and downloading records/reports. Financial-product and commercial opportunity capabilities will be introduced when verified, authorized information is available.

## Account model (accepted ADR-001)
- Multiple independent businesses, with separate and access-controlled financial information.
- Owners and staff have separate logins and business-specific roles.
- One person can belong to multiple businesses and have different roles in each.
- Owners manage invitations, membership and external report sharing.
- Protected operations must be authorized for the active business.

## End-to-end workflow goal
1. An authorized member sends a business message using the approved connected channel.
2. The AI provider proposes structured information, indicating uncertainty.
3. The user corrects or confirms the proposed record.
4. Application rules update relevant financial records and inventory.
5. Authorized members can review records and reports on the website.
6. Financing-readiness tools explain what records are available or missing; lenders retain financing decisions.

## Product boundaries
- AI interpretation is not independent transaction verification.
- Reports may be checkable for integrity without independently proving the facts contained in them.
- Mizvo does not take deposits, approve/issue loans or claim guaranteed financing.
- Unimplemented commercial and financial integrations cannot be described as live.
- Official WhatsApp policy eligibility, identity linking and data handling must be verified before real use.

## Accepted onboarding policy (ADR-002)
- Owners and staff can use a verified phone identity; a real email address is optional.
- Users can register from the website or the official WhatsApp conversation, once eligibility and verification delivery are configured.
- One Better Auth identity may hold multiple Organization memberships; business roles are enforced by the backend.
- Owners must enroll an additional independent recovery method before sensitive account-management actions; staff recovery is optional.
- Invitations may use a verified email or a verified phone, with expiring, single-use acceptance.

## Open product decisions
- Exact scope and order of the first user-facing release.
- The concrete OTP/email delivery vendor, verified WhatsApp account linkage and passkey/recovery-code implementation.
- Stock costing, cash handling, Ajo workflow and supported business categories.
- Report details, financing criteria and external evidence integrations.
