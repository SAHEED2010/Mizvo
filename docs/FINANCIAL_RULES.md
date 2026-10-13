# Financial integrity rules — required regardless of framework

## Basic accounting distinctions
- A sale can occur before the customer pays; **sales value is not cash received**.
- A purchase can occur before supplier payment; **purchase value is not immediate cash outflow**.
- A bank/POS entry and the corresponding sale can refer to one underlying event; do not double count.
- A loan disbursement, owner contribution or Ajo payout is not automatically sales revenue.
- Ajo contributions/payouts need explicit classification to avoid inflating income.
- Corrections and duplicate submissions must not silently rewrite ledger history.
- Inventory on hand cannot be asserted without sufficient opening-balance information.

## Example test case (fictional)
- Purchase: 400 packs of water for ₦800,000; derived unit cost ₦2,000/pack.
- Sale: 10 packs for ₦25,000; payment received ₦20,000.
- Under a per-pack purchase-cost assumption, cost of 10 packs = ₦20,000.
- Recorded gross margin for these sold units = ₦5,000, **before unrecorded operating costs**.
- Amount still owed by customer = ₦5,000.
- 390 packs remain **from this recorded purchase**, not necessarily the business's total inventory if opening stock is unknown.

## Precision and controls
- Decide money/quantity representations explicitly; do not use unguarded binary floats for money.
- Select and document a costing method before calling computed margin a general accounting result.
- Distinguish cost, selling price, payment and outstanding amount.
- Validate amounts, units and currency during posting.
- Use idempotency and database transactions.
- Preserve evidence provenance; a checkable report file is not verification of the business claims inside.

## Evidence states
- `self-reported`: owner entered it.
- `internally-reconciled`: consistent across stored records; not independently verified.
- `independently-corroborated`: corroborated by an authorized trustworthy independent source.
- `unresolved`: cannot yet be reconciled or lacks required confirmation.

Do not upgrade statuses just because AI believes a message or a receipt image looks credible.

## Test categories
Partial payment, unpaid sale, supplier credit, Ajo payout, duplicate delivery, corrections, mixed stock units, missing opening inventory, ambiguous voice transcription and report integrity.
