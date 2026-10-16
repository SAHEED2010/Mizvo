import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";

const CODE_ENTROPY_BYTES = 32;
const VERIFIER_DOMAIN = "mizvo/recovery-code/v1";
const CAPABILITY_PURPOSE = "synthetic_test";
const CAPABILITY_SCOPE = "recovery_state_only";

export type RecoveryCodeKeyring = Readonly<Record<string, Buffer>>;

export interface RecoveryCodeTestOptions {
  client: Sql;
  keyring: RecoveryCodeKeyring;
  activeKeyVersion: string;
  /** Limits are explicit test inputs; no live abuse policy has been approved. */
  rateLimit: { maxAttempts: number; windowMs: number };
  verifyPhoneOtpReceipt(receipt: string, userId: string): Promise<boolean>;
}

export type RecoveryCodeResult =
  | { accepted: true; capabilityId: string; capabilityToken: string; expiresAt: Date }
  | { accepted: false; reason: "invalid" | "rate_limited" };

export class RecoveryCodeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryCodeConfigurationError";
  }
}

function digest(key: Buffer, domain: string, userId: string, scopeId: string, value: string) {
  return createHmac("sha256", key)
    .update(`${domain}\0${userId}\0${scopeId}\0${value}`, "utf8")
    .digest("hex");
}

function isValidKey(key: Buffer | undefined): key is Buffer {
  return Buffer.isBuffer(key) && key.byteLength >= 32;
}

/**
 * Internal synthetic-account state machine for PostgreSQL security tests.
 * This module is deliberately not imported by Fastify or Better Auth handlers.
 */
export function createRecoveryCodeTestService(options: RecoveryCodeTestOptions) {
  if (process.env.NODE_ENV !== "test") {
    throw new RecoveryCodeConfigurationError("Recovery code test service is test-only");
  }
  if (!isValidKey(options.keyring[options.activeKeyVersion])) {
    throw new RecoveryCodeConfigurationError("Recovery verifier key is unavailable");
  }
  if (
    !Number.isInteger(options.rateLimit.maxAttempts) ||
    options.rateLimit.maxAttempts < 1 ||
    !Number.isInteger(options.rateLimit.windowMs) ||
    options.rateLimit.windowMs < 1
  ) {
    throw new RecoveryCodeConfigurationError("Explicit test rate limits are required");
  }

  const client = options.client;

  async function recordAudit(
    tx: Sql | TransactionSql,
    userId: string | null,
    attemptId: string | null,
    event: string,
    outcome: string,
  ) {
    await tx`
      INSERT INTO "recovery_audit_event" ("id", "user_id", "attempt_id", "event", "outcome")
      VALUES (${randomUUID()}, ${userId}, ${attemptId}, ${event}, ${outcome})
    `;
  }

  async function isSyntheticVerifiedUser(tx: Sql | TransactionSql, userId: string) {
    const rows = await tx`
      SELECT "id" FROM "user"
      WHERE "id" = ${userId}
        AND "phone_number_verified" = true
        AND "email_verified" = false
        AND "email" LIKE '%@users.invalid'
      LIMIT 1
    `;
    return rows.length === 1;
  }

  async function lockAccount(tx: Sql | TransactionSql, userId: string) {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`;
  }

  /** Codes leave this internal test boundary exactly once; only keyed HMACs persist. */
  async function issueForSyntheticTest(userId: string, codeCount: number) {
    if (!Number.isInteger(codeCount) || codeCount < 1 || codeCount > 16) {
      throw new RecoveryCodeConfigurationError("Test code count must be between 1 and 16");
    }
    const key = options.keyring[options.activeKeyVersion];
    if (!isValidKey(key))
      throw new RecoveryCodeConfigurationError("Recovery verifier key is unavailable");

    const codes = Array.from({ length: codeCount }, () =>
      randomBytes(CODE_ENTROPY_BYTES).toString("base64url"),
    );
    const setId = randomUUID();
    let epoch = 0;
    await client.begin(async (tx) => {
      await lockAccount(tx, userId);
      if (!(await isSyntheticVerifiedUser(tx, userId))) {
        throw new RecoveryCodeConfigurationError("Synthetic verified account required");
      }
      const epochs =
        await tx`SELECT COALESCE(MAX("epoch"), 0)::int AS epoch FROM "recovery_code_set" WHERE "user_id" = ${userId}`;
      epoch = Number(epochs[0]?.epoch ?? 0) + 1;
      await tx`
        UPDATE "recovery_code_set" SET "revoked_at" = now()
        WHERE "user_id" = ${userId} AND "revoked_at" IS NULL
      `;
      await tx`
        UPDATE "recovery_code" SET "revoked_at" = now()
        WHERE "user_id" = ${userId} AND "revoked_at" IS NULL AND "consumed_at" IS NULL
      `;
      await tx`
        UPDATE "recovery_capability" SET "revoked_at" = now()
        WHERE "user_id" = ${userId} AND "revoked_at" IS NULL AND "used_at" IS NULL
      `;
      await tx`
        INSERT INTO "recovery_code_set" ("id", "user_id", "epoch", "provenance")
        VALUES (${setId}, ${userId}, ${epoch}, 'synthetic_test')
      `;
      for (const code of codes) {
        const verifier = digest(key, VERIFIER_DOMAIN, userId, setId, code);
        await tx`
          INSERT INTO "recovery_code" ("id", "set_id", "user_id", "verifier", "key_version")
          VALUES (${randomUUID()}, ${setId}, ${userId}, ${verifier}, ${options.activeKeyVersion})
        `;
      }
      await recordAudit(tx, userId, null, "code_set_issued", "issued");
    });
    return { setId, epoch, codes };
  }

  async function rejectAttempt(
    tx: Sql | TransactionSql,
    userId: string,
    attemptId: string,
    outcome: "invalid_proof" | "invalid_code" | "rate_limited",
  ) {
    await tx`
      INSERT INTO "recovery_attempt" ("id", "user_id", "purpose", "outcome")
      VALUES (${attemptId}, ${userId}, ${CAPABILITY_PURPOSE}, ${outcome})
    `;
    await recordAudit(tx, userId, attemptId, "redemption_attempted", outcome);
    return {
      accepted: false as const,
      reason: outcome === "rate_limited" ? ("rate_limited" as const) : ("invalid" as const),
    };
  }

  async function redeemForSyntheticTest(input: {
    userId: string;
    attemptId: string;
    code: string;
    otpReceipt: string;
    capabilityExpiresAt: Date;
    now?: Date;
  }): Promise<RecoveryCodeResult> {
    // Plaintext is accepted only at this internal boundary and is never put in SQL,
    // audit rows, errors or logs. OTP receipts are passed to the injected test verifier.
    const now = input.now ?? new Date();
    if (!(input.capabilityExpiresAt instanceof Date) || input.capabilityExpiresAt <= now) {
      throw new RecoveryCodeConfigurationError("A future test capability expiry is required");
    }
    const otpValid =
      typeof input.otpReceipt === "string" &&
      (await options.verifyPhoneOtpReceipt(input.otpReceipt, input.userId));
    const codeShapeValid = /^[A-Za-z0-9_-]{43}$/.test(input.code);

    return client.begin(async (tx) => {
      await lockAccount(tx, input.userId);
      const recent = await tx`
        SELECT
          (SELECT count(*) FROM "recovery_attempt"
           WHERE "user_id" = ${input.userId}
             AND "created_at" >= ${new Date(now.getTime() - options.rateLimit.windowMs).toISOString()})
          +
          (SELECT count(*) FROM "recovery_audit_event"
           WHERE "user_id" = ${input.userId}
             AND "event" = 'redemption_attempted'
             AND "outcome" = 'replay'
             AND "created_at" >= ${new Date(now.getTime() - options.rateLimit.windowMs).toISOString()})
          AS count
      `;
      const existingAttempt =
        await tx`SELECT "id" FROM "recovery_attempt" WHERE "user_id" = ${input.userId} AND "id" = ${input.attemptId} LIMIT 1`;
      if (Number(recent[0]?.count ?? 0) >= options.rateLimit.maxAttempts) {
        if (!existingAttempt.length) {
          return rejectAttempt(tx, input.userId, input.attemptId, "rate_limited");
        }
        await recordAudit(
          tx,
          input.userId,
          input.attemptId,
          "redemption_attempted",
          "rate_limited",
        );
        return { accepted: false, reason: "rate_limited" };
      }
      if (existingAttempt.length) {
        await recordAudit(tx, input.userId, input.attemptId, "redemption_attempted", "replay");
        return { accepted: false, reason: "invalid" };
      }
      if (!(await isSyntheticVerifiedUser(tx, input.userId)) || !otpValid) {
        return rejectAttempt(tx, input.userId, input.attemptId, "invalid_proof");
      }
      const activeVersions = await tx`
        SELECT DISTINCT code."key_version" AS version
        FROM "recovery_code" code
        JOIN "recovery_code_set" code_set ON code_set."id" = code."set_id"
        WHERE code."user_id" = ${input.userId}
          AND code_set."revoked_at" IS NULL
          AND code."revoked_at" IS NULL
          AND code."consumed_at" IS NULL
      `;
      if (activeVersions.some((row) => !isValidKey(options.keyring[String(row.version)]))) {
        await tx`
          INSERT INTO "recovery_attempt" ("id", "user_id", "purpose", "outcome")
          VALUES (${input.attemptId}, ${input.userId}, ${CAPABILITY_PURPOSE}, 'key_unavailable')
        `;
        await recordAudit(
          tx,
          input.userId,
          input.attemptId,
          "redemption_attempted",
          "key_unavailable",
        );
        return { accepted: false, reason: "invalid" };
      }
      await tx`
        INSERT INTO "recovery_attempt" ("id", "user_id", "purpose", "outcome")
        VALUES (${input.attemptId}, ${input.userId}, ${CAPABILITY_PURPOSE}, 'pending')
      `;
      if (!codeShapeValid) {
        await tx`UPDATE "recovery_attempt" SET "outcome" = 'invalid_code' WHERE "id" = ${input.attemptId}`;
        await recordAudit(
          tx,
          input.userId,
          input.attemptId,
          "redemption_attempted",
          "invalid_code",
        );
        return { accepted: false, reason: "invalid" };
      }

      let consumed: { id: string; setId: string } | undefined;
      for (const row of activeVersions) {
        const keyVersion = String(row.version);
        const key = options.keyring[keyVersion];
        if (!isValidKey(key)) continue;
        const sets = await tx`
          SELECT "id" FROM "recovery_code_set"
          WHERE "user_id" = ${input.userId} AND "revoked_at" IS NULL
        `;
        for (const set of sets) {
          const verifier = digest(key, VERIFIER_DOMAIN, input.userId, String(set.id), input.code);
          const rows = await tx`
            UPDATE "recovery_code" code
            SET "consumed_at" = ${now.toISOString()}
            FROM "recovery_code_set" code_set
            WHERE code."set_id" = code_set."id"
              AND code."user_id" = ${input.userId}
              AND code."set_id" = ${String(set.id)}
              AND code."key_version" = ${keyVersion}
              AND code."verifier" = ${verifier}
              AND code."consumed_at" IS NULL
              AND code."revoked_at" IS NULL
              AND code_set."revoked_at" IS NULL
            RETURNING code."id", code."set_id" AS "setId"
          `;
          if (rows[0]) {
            consumed = { id: String(rows[0].id), setId: String(rows[0].setId) };
            break;
          }
        }
        if (consumed) break;
      }
      if (!consumed) {
        // The pending row is the rate-limit record. Update its generic outcome.
        await tx`UPDATE "recovery_attempt" SET "outcome" = 'invalid_code' WHERE "id" = ${input.attemptId}`;
        await recordAudit(
          tx,
          input.userId,
          input.attemptId,
          "redemption_attempted",
          "invalid_code",
        );
        return { accepted: false, reason: "invalid" };
      }

      const capabilityId = randomUUID();
      const capabilityToken = randomBytes(CODE_ENTROPY_BYTES).toString("base64url");
      const capabilityKey = options.keyring[options.activeKeyVersion];
      if (!isValidKey(capabilityKey)) {
        throw new RecoveryCodeConfigurationError("Recovery verifier key is unavailable");
      }
      const capabilityVerifier = digest(
        capabilityKey,
        "mizvo/recovery-capability/v1",
        input.userId,
        input.attemptId,
        capabilityToken,
      );
      await tx`
        UPDATE "recovery_attempt" SET "outcome" = 'redeemed' WHERE "id" = ${input.attemptId}
      `;
      await tx`
        INSERT INTO "recovery_capability" ("id", "user_id", "attempt_id", "purpose", "scope", "verifier", "key_version", "expires_at")
        VALUES (${capabilityId}, ${input.userId}, ${input.attemptId}, ${CAPABILITY_PURPOSE}, ${CAPABILITY_SCOPE}, ${capabilityVerifier}, ${options.activeKeyVersion}, ${input.capabilityExpiresAt.toISOString()})
      `;
      await recordAudit(tx, input.userId, input.attemptId, "redemption_attempted", "redeemed");
      return {
        accepted: true,
        capabilityId,
        capabilityToken,
        expiresAt: input.capabilityExpiresAt,
      };
    });
  }

  async function inspectRestrictedTestCapability(input: {
    capabilityId: string;
    capabilityToken: string;
    userId: string;
    attemptId: string;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const rows = await client`
      SELECT "id", "attempt_id" AS "attemptId", "key_version" AS "keyVersion", "verifier" FROM "recovery_capability"
      WHERE "id" = ${input.capabilityId}
        AND "user_id" = ${input.userId}
        AND "attempt_id" = ${input.attemptId}
        AND "purpose" = ${CAPABILITY_PURPOSE}
        AND "scope" = ${CAPABILITY_SCOPE}
        AND "expires_at" > ${now.toISOString()}
        AND "used_at" IS NULL AND "revoked_at" IS NULL
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return false;
    const key = options.keyring[String(row.keyVersion)];
    if (!isValidKey(key)) return false;
    const verifier = digest(
      key,
      "mizvo/recovery-capability/v1",
      input.userId,
      input.attemptId,
      input.capabilityToken,
    );
    return String(row.attemptId) === input.attemptId && String(row.verifier) === verifier;
  }

  async function consumeRestrictedTestCapability(input: {
    capabilityId: string;
    capabilityToken: string;
    userId: string;
    attemptId: string;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    return client.begin(async (tx) => {
      const existing = await tx`
        SELECT "key_version" AS "keyVersion" FROM "recovery_capability"
        WHERE "id" = ${input.capabilityId} AND "user_id" = ${input.userId} AND "attempt_id" = ${input.attemptId}
          AND "purpose" = ${CAPABILITY_PURPOSE} AND "scope" = ${CAPABILITY_SCOPE}
          AND "expires_at" > ${now.toISOString()} AND "used_at" IS NULL AND "revoked_at" IS NULL
        LIMIT 1
      `;
      const keyVersion = existing[0]?.keyVersion;
      const key = keyVersion ? options.keyring[String(keyVersion)] : undefined;
      if (!isValidKey(key)) return false;
      const verifier = digest(
        key,
        "mizvo/recovery-capability/v1",
        input.userId,
        input.attemptId,
        input.capabilityToken,
      );
      const rows = await tx`
        UPDATE "recovery_capability"
        SET "used_at" = ${now.toISOString()}
        WHERE "id" = ${input.capabilityId}
          AND "user_id" = ${input.userId}
          AND "attempt_id" = ${input.attemptId}
          AND "purpose" = ${CAPABILITY_PURPOSE}
          AND "scope" = ${CAPABILITY_SCOPE}
          AND "verifier" = ${verifier}
          AND "key_version" = ${String(keyVersion)}
          AND "expires_at" > ${now.toISOString()}
          AND "used_at" IS NULL AND "revoked_at" IS NULL
        RETURNING "id"
      `;
      if (!rows[0]) return false;
      await recordAudit(tx, input.userId, input.attemptId, "capability_used", "used");
      return true;
    });
  }

  async function revokeCodeSetsForSyntheticTest(userId: string) {
    return client.begin(async (tx) => {
      await lockAccount(tx, userId);
      const rows = await tx`
        UPDATE "recovery_code_set" SET "revoked_at" = now()
        WHERE "user_id" = ${userId} AND "revoked_at" IS NULL
        RETURNING "id"
      `;
      await tx`
        UPDATE "recovery_code" SET "revoked_at" = now()
        WHERE "user_id" = ${userId} AND "revoked_at" IS NULL
      `;
      await tx`
        UPDATE "recovery_capability" SET "revoked_at" = now()
        WHERE "user_id" = ${userId} AND "revoked_at" IS NULL AND "used_at" IS NULL
      `;
      await recordAudit(tx, userId, null, "code_set_revoked", "revoked");
      return rows.length;
    });
  }

  return {
    issueForSyntheticTest,
    redeemForSyntheticTest,
    inspectRestrictedTestCapability,
    consumeRestrictedTestCapability,
    revokeCodeSetsForSyntheticTest,
  };
}
