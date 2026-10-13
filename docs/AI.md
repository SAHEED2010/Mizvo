# AI architecture and agent responsibilities

**Status:** Proposed. We are **consuming** existing model APIs, not training a foundation model.

## Provider boundary
Start by evaluating Groq-hosted models for natural-language transaction extraction and speech transcription. Keep provider SDK calls inside `packages/ai/src/providers/` so a different provider can be substituted. Confirm current model names, rate limits and terms during implementation.

## Conceptual agents
- **Intent agent:** decide whether a message describes a transaction, asks a question or needs clarification.
- **Transaction agent:** propose structured purchase, sale, expense, payment, inventory or debt information.
- **Clarification agent:** ask for missing amounts, units, dates, payment status and ambiguous phrases.
- **Insights agent:** explain financial-engine outputs in clear language; never invent balances.

These are task-specific modules, **not necessarily four independent AI calls or an autonomous agent swarm**. Favor the simplest orchestration that passes tests.

## Required data flow
1. Receive message from website simulator or authorized WhatsApp integration.
2. Treat source text, audio and documents as untrusted data.
3. Use the provider for interpretation/transcription as appropriate.
4. Validate JSON output against a schema (to be designed in `API_CONTRACTS.md`).
5. Require clarification or confirmation before any financial posting.
6. Submit the confirmed event to the financial core and database transaction.
7. Return the computed result to the owner.

## Rules
- Never ask the model to calculate final financial balances.
- Never give the model broad direct database write access.
- Do not automatically classify Ajo receipts as sales or loans as income.
- AI-derived values are not independently verified facts.
- Do not fabricate receipt OCR values or fill in omitted inventory quantities.
- Keep prompts free of secrets and other businesses' records.
- Log errors and schema-validation failures without storing unnecessary sensitive prompts.

## Pending decisions
Specific Groq model IDs, strict JSON schema, voice/receipt scope, evaluation set, token and cost limits, data retention and vendor processing terms. An example prompt is not a substitute for these contracts.
