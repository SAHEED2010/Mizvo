# Architecture Decision Records (ADRs)

Record important decisions before changes that would otherwise force Codex or teammates to guess.

## Process
1. Copy `000-template.md` into a new numbered file (for example `001-first-demo-scope.md`).
2. Mark `Status: Proposed` while alternatives remain under discussion.
3. Document options, trade-offs, security/data implications and the decision maker.
4. Change to `Accepted` only after the team agrees; update links in relevant technical docs.
5. If reversing a decision, add a new ADR that supersedes the old one. Keep history.

**No numbered architecture choices are declared accepted by this initial scaffold.**

## Expected first decisions
- Demo scope and business/account model.
- Financial event representation, precision and inventory costing.
- Authentication and data isolation.
- API contracts and AI extraction/confirmation schema.
- Report format, evidence handling and any external integrations.
