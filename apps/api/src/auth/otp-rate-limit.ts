import { createHash, randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { normalizeNigerianPhoneNumber } from "./sms.js";

export type OtpOperation = "request" | "verify";

export interface OtpRateLimiter {
  consume(operation: OtpOperation, phoneNumber: string | null, ipAddress: string): Promise<boolean>;
  close(): Promise<void>;
}

const WINDOW_MS = 15 * 60 * 1000;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createPostgresOtpRateLimiter(client: Sql): OtpRateLimiter {
  async function increment(key: string): Promise<number> {
    const now = Date.now();
    const [{ count }] = await client<{ count: number }[]>`
      INSERT INTO "rate_limit" ("id", "key", "count", "last_request")
      VALUES (${randomUUID()}, ${key}, 1, ${now})
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE
          WHEN "rate_limit"."last_request" <= ${now - WINDOW_MS} THEN 1
          ELSE "rate_limit"."count" + 1
        END,
        "last_request" = ${now}
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
