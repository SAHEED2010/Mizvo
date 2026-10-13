# AI integration and logical agents

**Status:** Design baseline, not deployed. Mizvo will consume a hosted AI API rather than train its own foundation model.

## Provider approach
GroqCloud is the current initial provider candidate for natural-language extraction and audio transcription. Evaluate exact models, costs, terms, privacy and accuracy before locking IDs. Isolate SDK calls behind an interchangeable provider adapter.

## Agent responsibilities (logical modules)
- `intent`: classify the user's request (recording, querying, clarification).
- `transaction`: extract a **proposed** sale, purchase, payment or other business event.
- `clarification`: resolve missing/ambiguous amounts, units, dates and payment status.
- `insights`: explain **already computed and authorized** business figures in plain language.

An agent folder does not mean four separate autonomous LLM agents or four API charges for every message.

## Processing boundaries
1. Receive text/voice/document through a properly authorized and verified integration.
2. Establish business context through authenticated/authorized user membership. Do not infer ownership from message content or phone number alone.
3. Interpret through hosted AI, checking provider errors/rate limits.
4. Validate structured output and retain it as a draft, not a posted transaction.
5. Obtain user confirmation where appropriate.
6. Run deterministic accounting code and post atomically to the correct business.
7. Return accurate, limited and permission-scoped results.

## Security and correctness
- Restrict AI access to the minimum authorized business data needed.
- Do not let user text, receipts or message attachments override system instructions or permissions.
- Never expose API keys in the frontend or stored messages.
- External content is not independently verified just because the model interprets it.
- No AI tool may execute unrestricted SQL or bypass confirmation.
- Use only permitted and appropriately protected data with external AI services.

## Further decisions
Model IDs and extraction schemas, exact WhatsApp linking/auth workflow, data retention, cost controls, retries and job processing.
