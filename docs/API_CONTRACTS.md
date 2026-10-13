# API contracts — design worksheet

**Status: NOT FINALIZED. The routes below are candidates, not implemented endpoints.**

The website and messaging adapter should share the same underlying Fastify business services.

| Candidate operation | Intent |
| --- | --- |
| `POST /v1/interpret` | Propose a transaction draft from conversational input |
| `POST /v1/drafts/:id/confirm` | Validate and post an owner-confirmed event |
| `GET /v1/transactions` | Query business-scoped records |
| `GET /v1/inventory` | Retrieve inventory movement summary |
| `GET /v1/summary` | Fetch deterministic business metrics |
| `POST /v1/reports` | Request a report from stored records |
| `GET /v1/reports/:id` | Retrieve report metadata, subject to authorization |
| `POST /v1/webhooks/whatsapp` | Conditional verified webhook receiver |

## Contract decisions needed
- Auth method, business context and permissions.
- Request/response schemas for purchases, sales, payments and corrections.
- How drafts store source message ID and confirmation state.
- Stable error format, pagination and timestamps.
- Idempotency keys for confirmation and message redelivery.
- Distinguishing simulation from real messaging.
- PDF authorization and whether verification pages are public or gated.

Do not generate clients, controllers or migrations until contracts are reviewed.
