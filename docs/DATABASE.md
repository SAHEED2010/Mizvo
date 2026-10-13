# Financial data model — design worksheet

**Status: NOT FINALIZED. No migrations should be generated from this document yet.**

## Entities to evaluate
- `businesses`: business identity and settings.
- `users` / `memberships`: only if multi-account login is approved.
- `products`, `units`: catalog and unit conversion.
- `transactions`, `transaction_items`: purchases, sales, expenses and corrections.
- `payments`: amount received or paid; may settle a separate sale or purchase.
- `inventory_movements`: changes with a traceable source.
- `obligations`: customer receivables and supplier payables.
- `ai_drafts`: model-extracted proposals awaiting confirmation.
- `evidence`: source, provenance and corroboration status.
- `audit_events`: append-only significant changes.
- `reports`: generated versions and integrity metadata.
- `message_receipts`: message IDs/idempotency metadata if live messaging is approved.

Names above are **candidates**, not a schema contract.

## Questions to decide before migrations
1. Single fictional demo business or genuine multi-tenant model?
2. How are a sale, payment and inventory movement linked without double counting?
3. Exact money representation (integer kobo and/or decimal numeric).
4. Costing method (for example weighted average), quantities and unit conversions.
5. Corrections: reversing event versus mutable row with audit history.
6. Opening stock unknown versus initialized/confirmed.
7. Idempotency keys and uniqueness constraints.
8. Evidence states, business permissions and report versioning.

## Invariants regardless of schema
- Posting must be atomic, scoped and idempotent.
- Purchase/sale/payment events remain distinguishable.
- Corrections must be traceable.
- Unknown information remains unknown rather than zero by assumption.

See `FINANCIAL_RULES.md`.
