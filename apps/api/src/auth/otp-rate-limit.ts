import { createHash, randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { normalizeNigerianPhoneNumber } from "./sms.js";

export type OtpOperation = "request" | "verify";

export interface OtpRateLimiter {
  consume(operation: OtpOperation, phoneNumber: string | null, ipAddress: string): Promise<boolean>;
  close(): Promise<void>;
}

const WINDOW_MS = 15 * 60 * 1000;
const CLEANUP_INTERVAL_MS = WINDOW_MS;

interface OtpRateLimiterOptions {
  now?: () => number;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createPostgresOtpRateLimiter(
  client: Sql,
  options: OtpRateLimiterOptions = {},
): OtpRateLimiter {
  const now = options.now ?? Date.now;
  let nextCleanupAt = 0;

  async function cleanupExpiredBuckets(timestamp: number): Promise<void> {
    if (timestamp < nextCleanupAt) return;
    await client`
      DELETE FROM "rate_limit"
      WHERE "key" LIKE 'mizvo:otp:%'
        AND "last_request" <= ${timestamp - WINDOW_MS}
    `;
    nextCleanupAt = timestamp + CLEANUP_INTERVAL_MS;
  }

  async function increment(key: string): Promise<number> {
    const timestamp = now();
    await cleanupExpiredBuckets(timestamp);
    const [{ count }] = await client<{ count: number }[]>`
      INSERT INTO "rate_limit" ("id", "key", "count", "last_request")
      VALUES (${randomUUID()}, ${key}, 1, ${timestamp})
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE
          WHEN "rate_limit"."last_request" <= ${timestamp - WINDOW_MS} THEN 1
          ELSE "rate_limit"."count" + 1
        END,
        -- Keep last_request as the fixed-window start until the next window begins.
        "last_request" = CASE
          WHEN "rate_limit"."last_request" <= ${timestamp - WINDOW_MS} THEN ${timestamp}
          ELSE "rate_limit"."last_request"
        END
      RETURNING "count"
    `;
    return count ?? Number.POSITIVE_INFINITY;
  }

  return {
    async consume(operation, rawPhoneNumber, ipAddress) {
      const phoneNumber = rawPhoneNumber ? normalizeNigerianPhoneNumber(rawPhoneNumber) : null;
      const ipHash = digest(ipAddress || "unknown");
      const ipLimit = operation === "request" ? 20 : 60;
      const ipCount = await increment(`mizvo:otp:${operation}:ip:${ipHash}`);
      if (ipCount > ipLimit) return false;
      if (!phoneNumber) return true;

      const phoneHash = digest(phoneNumber);
      const phoneLimit = operation === "request" ? 3 : 10;
      const phoneCount = await increment(`mizvo:otp:${operation}:phone:${phoneHash}`);
      return phoneCount <= phoneLimit;
    },
    async close() {
      await client.end();
    },
  };
}
