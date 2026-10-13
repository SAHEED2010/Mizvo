# Product brief — Mizvo

**Status:** Working proposal. Demo scope must be reviewed before coding.

## Problem
Nigerian small businesses may record purchases, cash/POS/bank payments, debts, inventory, and informal savings separately. This can make it difficult for owners to explain performance or prepare useful documentation when seeking financing and growth opportunities.

## Proposed solution
A WhatsApp-first assistant for recording and understanding everyday business activity, backed by a deterministic financial engine. Owners can review, correct and download records through a website. Financing-readiness information is educational and based on documented requirements; Mizvo does **not** approve or provide loans.

## Users
Initial illustrative user: Nigerian micro or small trader/retailer. The broader concept includes women-led, informal and partially digitized SMEs, including services where inventory is optional.

## First complete demonstration journey
1. Merchant describes purchase and sale in conversational text.
2. AI produces a **draft**, asking questions when facts are missing.
3. User confirms/corrects the draft.
4. System posts purchase/sale and separate payment records.
5. Dashboard displays stock movement, amounts owed and appropriately scoped profit figures.
6. User downloads a report with transparent evidence labels.
7. Financing-readiness view identifies missing information and shows clearly illustrative financing requirements.

## What we should NOT claim
- That the system independently verifies every self-reported transaction.
- That a report signature proves business activity was true.
- That lender integrations, approvals, bank data or commercial partnerships already exist.
- That a fictional or seeded opportunity is a real buyer match.
- That initial demo accuracy or impact is already established.

## Pending scope decisions
- One seeded demo business or multiple isolated business accounts?
- Authentication: demo-only fixture or real website sign-in?
- Text-only core versus voice and receipt handling in demo?
- Which inventory costing method and which kinds of local units?
- Which financing-readiness screens are necessary for the presentation?
- Can WhatsApp be used compliantly, or should we demonstrate in a simulator?

See `BUILD_PLAN.md` and forthcoming ADRs. Do not assume these questions are already settled.
