# ADR-004: Website phone OTP delivery boundary

- **Status:** Proposed; pending explicit team approval
- **Date:** 2026-10-14
- **Decision owners:** Mizvo team
- **Depends on:** [ADR-002: Phone-first authentication](002-authentication-whatsapp-onboarding-and-recovery.md)

## Context

Phase B implements the accepted Better Auth Phone Number flow for website accounts. The repository needs an SMS transport that can be tested without external delivery and swapped if an approved vendor changes. Africa's Talking is the Phase B implementation candidate, not a binding vendor decision. Nigeria sender ID approval, account eligibility, cost and delivery terms remain unverified and require separate human action.

## Decision

This proposal recommends the following Phase B implementation boundary, pending explicit team approval:

1. Better Auth generates, stores, verifies and consumes the phone OTP. Its Phone Number plugin is the sole OTP identity and attempt store; the API does not introduce a second OTP table.
2. SMS is sent through a backend-only `SmsTransport` interface. Africa's Talking's official Node SDK is a candidate adapter for the Phase B implementation.
3. A production adapter requires server-side credentials and a configured sender ID. Sandbox is explicit and requires the Africa's Talking sandbox username. An accepted, processed or queued provider response is not treated as proof of handset delivery.
4. A dependency-injected fake transport is used by tests. No fake transport is enabled by runtime environment variables or exposed through public routes.
5. OTP request limits use the existing Better Auth rate-limit model with database storage and additional hashed phone/IP buckets. Authentication remains disabled by default.
6. Browser auth calls use a same-origin Next.js rewrite, exact trusted-origin checks, HttpOnly/SameSite cookies, Secure cookies in production, and a seven-day session lifetime with refresh disabled.
7. Optional email editing/verification is unavailable until an approved email delivery provider is configured. Phone-only accounts keep Better Auth's unique non-deliverable `.invalid` address unverified.

## Consequences

- Tests can assert verification and delivery behavior without contacting Africa's Talking or printing codes.
- Production deployment still needs reviewed privacy/terms, vendor eligibility, approved transactional sender ID, pricing and delivery requirements, valid credentials, HTTPS and trusted proxy configuration.
- OTP delivery failures fail closed and do not create authenticated sessions. Safe errors omit provider response text, phone numbers and OTP values.
- Phase B does not add business creation, recovery enrollment, step-up, invitations, WhatsApp onboarding or financial endpoints.

## References

- [Better Auth Phone Number plugin](https://www.better-auth.com/docs/plugins/phone-number)
- [Better Auth session management](https://www.better-auth.com/docs/concepts/session-management)
- [Africa's Talking Node SDK](https://developers.africastalking.com/sdks)
- [Africa's Talking messaging error codes](https://help.africastalking.com/en/articles/16150386-messaging-error-codes)
- [Africa's Talking Nigeria sender ID requirements](https://help.africastalking.com/en/articles/2257657-how-do-i-get-a-sender-id-in-nigeria)
