# Phone authentication setup

Build 002 Phase B implements a website phone OTP flow through Better Auth's Phone Number plugin. For an existing verified phone it signs the user in; for a new phone it creates the account only after OTP verification. Business creation and membership setup are later work.

## Current behavior

- Only valid Nigerian mobile numbers are supported. The website accepts common national input and sends canonical `+234` E.164 values to the API.
- Better Auth generates six-digit codes, expires them after five minutes, allows at most three wrong attempts and consumes them once. The delivery adapter does not verify or store a second copy of a code.
- Requests and verification attempts are rate-limited by Better Auth's persistent IP limit and additional database-backed IP/phone buckets. Phone request budgets are three per fifteen minutes; verification budgets are ten per phone per fifteen minutes.
- Browser auth goes through the same-origin `/api/auth` Next.js rewrite. API POSTs require an exact configured `Origin`. Sessions use HttpOnly, SameSite=Lax cookies, Secure cookies in production, and an absolute seven-day expiry with refresh disabled. The API validates sessions using Better Auth and signs out through its session revocation endpoint.
- Optional email is unavailable. Email change is disabled and a phone-only account's Better Auth placeholder uses the reserved `.invalid` domain, remains unverified and cannot be used for delivery.
- Failed or missing SMS configuration returns a generic failure. No user session is created on delivery failure. The public API never returns an OTP; provider errors, OTP values and raw provider responses are not logged.

## Enabling authentication

`AUTH_ENABLED` remains `false` in `.env.example`. Do not enable it for real users until all deployment and vendor checks are complete.

Set the following in the **API server's secret environment**, never in a `NEXT_PUBLIC_*` variable or a browser bundle:

- `AUTH_ENABLED=true`
- `DATABASE_URL` for the intended PostgreSQL database after applying committed migrations
- `BETTER_AUTH_SECRET` with at least 32 random characters
- `BETTER_AUTH_URL` for the public auth origin configured in deployment
- `BETTER_AUTH_TRUSTED_ORIGINS` as a comma-separated list of exact website origins (scheme, host and port)
- `AT_ENVIRONMENT=production`, `AT_USERNAME`, `AT_API_KEY` and an Africa's Talking `AT_SENDER_ID` that has actually been approved for Nigeria
- `MIZVO_API_ORIGIN` in the Next.js server environment, pointing at the private Fastify API origin
- `TRUSTED_PROXY_CIDRS` only when Fastify is behind known reverse proxies; list only their actual IPs/CIDRs

No provider account, sender ID, funds or real credentials are provisioned by this code change. Confirm account eligibility, current pricing, transaction message rules, Nigerian sender requirements and delivery terms with Africa's Talking before use. Never treat a `Processed`, `Sent`, `Queued` or SDK success response as handset delivery; this adapter reports it only as accepted by the provider. Delivery reports are not configured in Phase B.

For authorized provider sandbox testing, explicitly set `AT_ENVIRONMENT=sandbox`, use the vendor's sandbox account username and credentials, and remember that the sandbox response does not demonstrate real SMS delivery. CI uses an injected fake transport and does not contact the vendor.

Apply migrations with the repository's PostgreSQL migration process before enabling auth. CI's PostgreSQL integration tests only target the isolated local `mizvo_test` database. Production needs a separate security/privacy and deployment review, including HTTPS, proxy IP forwarding, OTP retention and provider contract review.
