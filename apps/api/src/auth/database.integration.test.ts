import { spawn } from "node:child_process";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createDatabase } from "@mizvo/database";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { chromium, type Page } from "playwright";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createAuth } from "./auth.js";
import { createPostgresOtpRateLimiter } from "./otp-rate-limit.js";
import { currentOwnerSensitiveActionDecision } from "./owner-sensitive-action-guard.js";
import {
  acceptPhoneInvitation,
  createPhoneInvitation,
  revokePhoneInvitation,
} from "./phone-invitations.js";
import { requireVerifiedPasskeyEnrollment } from "./plugins.js";
import { createRecoveryCodeTestService } from "./recovery-codes.js";
import type { SmsTransport } from "./sms.js";
import { createStepUpTestService } from "./step-up-test-service.js";

type RegistrationResponse = {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports: string[];
  };
  clientExtensionResults: Record<string, unknown>;
  authenticatorAttachment: string | null;
};

function readCborHeader(bytes: Buffer, offset: number) {
  const first = bytes[offset];
  if (first === undefined) throw new Error("Unexpected end of CBOR data");
  const majorType = first >> 5;
  const additional = first & 31;
  if (additional < 24) return { majorType, length: additional, nextOffset: offset + 1 };
  if (additional === 24) {
    const length = bytes.readUInt8(offset + 1);
    return { majorType, length, nextOffset: offset + 2 };
  }
  if (additional === 25) {
    const length = bytes.readUInt16BE(offset + 1);
    return { majorType, length, nextOffset: offset + 3 };
  }
  if (additional === 26) {
    const length = bytes.readUInt32BE(offset + 1);
    return { majorType, length, nextOffset: offset + 5 };
  }
  if (additional === 27) {
    const length = Number(bytes.readBigUInt64BE(offset + 1));
    if (!Number.isSafeInteger(length)) throw new Error("Unsupported CBOR integer length");
    return { majorType, length, nextOffset: offset + 9 };
  }
  throw new Error("Indefinite-length CBOR is not expected in WebAuthn attestation");
}

function skipCborValue(bytes: Buffer, offset: number): number {
  const header = readCborHeader(bytes, offset);
  if (header.majorType === 0 || header.majorType === 1 || header.majorType === 7) {
    return header.nextOffset;
  }
  if (header.majorType === 2 || header.majorType === 3) return header.nextOffset + header.length;
  if (header.majorType === 4) {
    let nextOffset = header.nextOffset;
    for (let index = 0; index < header.length; index++) {
      nextOffset = skipCborValue(bytes, nextOffset);
    }
    return nextOffset;
  }
  if (header.majorType === 5) {
    let nextOffset = header.nextOffset;
    for (let index = 0; index < header.length * 2; index++) {
      nextOffset = skipCborValue(bytes, nextOffset);
    }
    return nextOffset;
  }
  if (header.majorType === 6) return skipCborValue(bytes, header.nextOffset);
  throw new Error("Unsupported CBOR value in WebAuthn attestation");
}

function getAttestedAuthenticatorDataOffset(bytes: Buffer): number {
  const map = readCborHeader(bytes, 0);
  if (map.majorType !== 5) throw new Error("WebAuthn attestation object must be a CBOR map");
  let offset = map.nextOffset;
  for (let index = 0; index < map.length; index++) {
    const key = readCborHeader(bytes, offset);
    if (key.majorType !== 3) throw new Error("WebAuthn attestation keys must be CBOR text");
    const keyEnd = key.nextOffset + key.length;
    const name = bytes.toString("utf8", key.nextOffset, keyEnd);
    offset = keyEnd;
    if (name === "authData") {
      const value = readCborHeader(bytes, offset);
      if (value.majorType !== 2 || value.length < 37) {
        throw new Error("WebAuthn attestation authData must be a byte string");
      }
      return value.nextOffset;
    }
    offset = skipCborValue(bytes, offset);
  }
  throw new Error("WebAuthn attestation is missing authData");
}

function rewriteClientData(
  response: RegistrationResponse,
  mutate: (clientData: Record<string, unknown>) => void,
): RegistrationResponse {
  const changed = structuredClone(response);
  const clientData = JSON.parse(
    Buffer.from(changed.response.clientDataJSON, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  mutate(clientData);
  changed.response.clientDataJSON = Buffer.from(JSON.stringify(clientData)).toString("base64url");
  return changed;
}

async function createAuthenticationResponse(
  page: Page,
  options: PublicKeyCredentialRequestOptionsJSON,
): Promise<AuthenticationResponseJSON> {
  return page.evaluate(async (requestOptions) => {
    const fromBase64url = (value: string) => {
      const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
      const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
      const binary = atob(padded);
      return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
    };
    const toBase64url = (value: ArrayBuffer) => {
      const bytes = new Uint8Array(value);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    };
    const publicKey = {
      ...requestOptions,
      challenge: fromBase64url(requestOptions.challenge),
      allowCredentials: requestOptions.allowCredentials?.map((credential) => ({
        type: credential.type,
        id: fromBase64url(credential.id),
      })),
    };
    const credential = (await navigator.credentials.get({
      publicKey,
    })) as PublicKeyCredential | null;
    if (!credential) throw new Error("virtual authenticator returned no assertion");
    const assertion = credential.response as AuthenticatorAssertionResponse;
    return {
      id: credential.id,
      rawId: toBase64url(credential.rawId),
      type: credential.type as "public-key",
      response: {
        clientDataJSON: toBase64url(assertion.clientDataJSON),
        authenticatorData: toBase64url(assertion.authenticatorData),
        signature: toBase64url(assertion.signature),
        userHandle: assertion.userHandle ? toBase64url(assertion.userHandle) : null,
        transports: [],
      },
      clientExtensionResults: credential.getClientExtensionResults() as Record<string, unknown>,
      authenticatorAttachment: credential.authenticatorAttachment as string | null,
    };
  }, options) as Promise<AuthenticationResponseJSON>;
}

function rewriteAssertionClientData(
  response: AuthenticationResponseJSON,
  mutate: (clientData: Record<string, unknown>) => void,
): AuthenticationResponseJSON {
  const changed = structuredClone(response);
  const clientData = JSON.parse(
    Buffer.from(changed.response.clientDataJSON, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  mutate(clientData);
  changed.response.clientDataJSON = Buffer.from(JSON.stringify(clientData)).toString("base64url");
  return changed;
}

function clearAssertionUserVerification(
  response: AuthenticationResponseJSON,
): AuthenticationResponseJSON {
  const changed = structuredClone(response);
  const authenticatorData = Buffer.from(changed.response.authenticatorData, "base64url");
  const flags = authenticatorData.at(32);
  if (flags === undefined || (flags & 0x04) === 0) {
    throw new Error("Virtual authenticator ceremony did not set the UV flag");
  }
  authenticatorData[32] = flags & ~0x04;
  changed.response.authenticatorData = authenticatorData.toString("base64url");
  return changed;
}

function changeAssertionRpIdHash(
  response: AuthenticationResponseJSON,
  rpId: string,
): AuthenticationResponseJSON {
  const changed = structuredClone(response);
  const authenticatorData = Buffer.from(changed.response.authenticatorData, "base64url");
  createHash("sha256").update(rpId).digest().copy(authenticatorData, 0);
  changed.response.authenticatorData = authenticatorData.toString("base64url");
  return changed;
}

function alterAssertionSignature(response: AuthenticationResponseJSON): AuthenticationResponseJSON {
  const changed = structuredClone(response);
  const signature = Buffer.from(changed.response.signature, "base64url");
  signature[0] = (signature[0] ?? 0) ^ 0x01;
  changed.response.signature = signature.toString("base64url");
  return changed;
}

function clearWebAuthnUserVerification(response: RegistrationResponse): RegistrationResponse {
  const changed = structuredClone(response);
  const attestation = Buffer.from(changed.response.attestationObject, "base64url");
  const authenticatorDataOffset = getAttestedAuthenticatorDataOffset(attestation);
  const flagsOffset = authenticatorDataOffset + 32;
  const flags = attestation.at(flagsOffset);
  if (flags === undefined || (flags & 0x04) === 0) {
    throw new Error("Virtual authenticator ceremony did not set the UV flag");
  }
  attestation[flagsOffset] = flags & ~0x04;
  changed.response.attestationObject = attestation.toString("base64url");
  return changed;
}

function changeWebAuthnRpIdHash(
  response: RegistrationResponse,
  rpId: string,
): RegistrationResponse {
  const changed = structuredClone(response);
  const attestation = Buffer.from(changed.response.attestationObject, "base64url");
  const authenticatorDataOffset = getAttestedAuthenticatorDataOffset(attestation);
  const rpIdHash = createHash("sha256").update(rpId).digest();
  rpIdHash.copy(attestation, authenticatorDataOffset);
  changed.response.attestationObject = attestation.toString("base64url");
  return changed;
}

const databaseUrl = process.env.DATABASE_URL;
const postgresSuite = databaseUrl ? describe : describe.skip;

postgresSuite("authentication PostgreSQL invariants", () => {
  let client: ReturnType<typeof postgres>;
  let otpRateLimiter: ReturnType<typeof createPostgresOtpRateLimiter>;
  const authDatabases: Array<ReturnType<typeof createDatabase>> = [];
  const deliveries: Array<{ phoneNumber: string; code: string }> = [];
  const smsTransport: SmsTransport = {
    async sendVerificationCode(phoneNumber, code) {
      deliveries.push({ phoneNumber, code });
      return { status: "accepted" };
    },
  };

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
    const target = new URL(databaseUrl);
    if (!["127.0.0.1", "::1"].includes(target.hostname) || target.pathname !== "/mizvo_test") {
      throw new Error(
        "PostgreSQL tests only run against the isolated local mizvo_test database; refusing other targets",
      );
    }

    client = postgres(databaseUrl, { max: 8, prepare: false });
    otpRateLimiter = createPostgresOtpRateLimiter(
      postgres(databaseUrl, { max: 2, prepare: false }),
    );
    const db = drizzle(client);
    await migrate(db, {
      migrationsFolder: resolve(process.cwd(), "../../packages/database/migrations"),
    });
  });

  beforeEach(async () => {
    deliveries.length = 0;
    await client`TRUNCATE TABLE "step_up_test_audit_event", "step_up_proof", "step_up_challenge", "step_up_test_identity", "recovery_audit_event", "recovery_capability", "recovery_attempt", "recovery_code", "recovery_code_set", "business_audit_event", "phone_invitation", "invitation", "member", "organization", "session", "account", "verification", "rate_limit", "user" CASCADE`;
  });

  afterAll(async () => {
    await otpRateLimiter?.close();
    await Promise.all(authDatabases.map((database) => database.client.end()));
    await client?.end();
  });

  function createTestAuth() {
    const database = createDatabase(databaseUrl as string);
    authDatabases.push(database);
    return createAuth(
      {
        DATABASE_URL: databaseUrl,
        BETTER_AUTH_SECRET: "integration-test-secret-with-at-least-32-chars",
        BETTER_AUTH_URL: "https://auth.mizvo.test",
        BETTER_AUTH_TRUSTED_ORIGINS: "https://app.mizvo.test",
        NODE_ENV: "production",
      },
      { database, smsTransport },
    );
  }

  function createDevelopmentPasskeyApp() {
    return buildApp(
      {
        AUTH_ENABLED: "true",
        DATABASE_URL: databaseUrl as string,
        BETTER_AUTH_SECRET: "integration-test-secret-with-at-least-32-chars",
        BETTER_AUTH_URL: "http://127.0.0.1:4000",
        BETTER_AUTH_TRUSTED_ORIGINS: "http://localhost:3000",
        MIZVO_PASSKEY_ENROLLMENT: "development",
        NODE_ENV: "development",
      },
      { smsTransport },
    );
  }

  function createRecoveryTestService(
    options: {
      keyVersion?: string;
      key?: Buffer;
      keyring?: Readonly<Record<string, Buffer>>;
      client?: ReturnType<typeof postgres>;
      maxAttempts?: number;
      verifyPhoneOtpReceipt?: (receipt: string, userId: string) => Promise<boolean>;
    } = {},
  ) {
    const keyVersion = options.keyVersion ?? "test-v1";
    const key = options.key ?? Buffer.alloc(32, 0x51);
    return createRecoveryCodeTestService({
      client: options.client ?? client,
      keyring: options.keyring ?? { [keyVersion]: key },
      activeKeyVersion: keyVersion,
      rateLimit: { maxAttempts: options.maxAttempts ?? 20, windowMs: 5 * 60_000 },
      verifyPhoneOtpReceipt:
        options.verifyPhoneOtpReceipt ??
        (async (receipt, userId) => receipt === `verified-test-otp:${userId}`),
    });
  }

  async function createSyntheticRecoveryUser(phoneVerified = true) {
    const id = `synthetic-${randomUUID()}`;
    const phoneNumber = `+234${randomInt(1_000_000_000, 9_999_999_999)}`;
    await client`
      INSERT INTO "user" ("id", "name", "email", "email_verified", "phone_number", "phone_number_verified")
      VALUES (${id}, 'Synthetic Recovery User', ${`${id}@users.invalid`}, false, ${phoneNumber}, ${phoneVerified})
    `;
    await client`
      INSERT INTO "recovery_test_identity" ("user_id", "designation")
      VALUES (${id}, 'synthetic_fixture')
    `;
    return id;
  }

  async function registerThroughApp(app: ReturnType<typeof buildApp>, phoneNumber: string) {
    const origin = "http://localhost:3000";
    const requested = await app.inject({
      method: "POST",
      url: "/api/auth/phone-number/send-otp",
      payload: { phoneNumber },
      headers: { origin },
    });
    expect(requested.statusCode).toBe(200);
    const verified = await app.inject({
      method: "POST",
      url: "/api/auth/phone-number/verify",
      payload: { phoneNumber, code: deliveries.at(-1)?.code },
      headers: { origin },
    });
    expect(verified.statusCode).toBe(200);
    const cookies = verified.headers["set-cookie"];
    const cookie = (Array.isArray(cookies) ? cookies : [cookies])
      .filter((value): value is string => Boolean(value))
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    const [user] =
      await client`SELECT "id", "phone_number", "phone_number_verified" FROM "user" WHERE "phone_number" = ${phoneNumber}`;
    return { cookie, user };
  }

  async function authRequest(
    auth: ReturnType<typeof createAuth>,
    path: string,
    body?: Record<string, unknown>,
    cookie?: string,
    origin = "https://app.mizvo.test",
  ) {
    return auth.handler(
      new Request(`https://auth.mizvo.test/api/auth${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          Origin: origin,
          ...(body ? { "content-type": "application/json" } : {}),
          ...(cookie ? { cookie } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  }

  async function seedBusiness(ownerCount = 1) {
    const organizationId = "org-test";
    await client`INSERT INTO "organization" ("id", "name", "slug", "created_at") VALUES (${organizationId}, 'Test business', 'test-business', now())`;
    const users = Array.from({ length: ownerCount + 2 }, (_, index) => `user-${index + 1}`);
    for (const [index, id] of users.entries()) {
      await client`INSERT INTO "user" ("id", "name", "email") VALUES (${id}, ${id}, ${`${id}@example.invalid`})`;
      if (index < ownerCount) {
        await client`INSERT INTO "member" ("id", "organization_id", "user_id", "role", "created_at") VALUES (${`member-${id}`}, ${organizationId}, ${id}, 'owner', now())`;
      }
    }
    return { organizationId, users };
  }

  it("issues only high-entropy synthetic recovery codes and persists keyed verifiers", async () => {
    const userId = await createSyntheticRecoveryUser();
    const service = createRecoveryTestService();
    const issued = await service.issueForSyntheticTest(userId, 8);

    expect(issued.epoch).toBe(1);
    expect(issued.codes).toHaveLength(8);
    for (const code of issued.codes) {
      expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(code, "base64url")).toHaveLength(32);
    }
    const stored = await client`
      SELECT code."verifier", code."key_version", code_set."provenance"
      FROM "recovery_code" code
      JOIN "recovery_code_set" code_set ON code_set."id" = code."set_id"
      WHERE code."user_id" = ${userId}
    `;
    expect(stored).toHaveLength(8);
    expect(stored.every((row) => /^[0-9a-f]{64}$/.test(String(row.verifier)))).toBe(true);
    expect(
      stored.every((row) => row.key_version === "test-v1" && row.provenance === "synthetic_test"),
    ).toBe(true);
    const audit =
      await client`SELECT "event", "outcome" FROM "recovery_audit_event" WHERE "user_id" = ${userId}`;
    const serializedAudit = JSON.stringify(audit);
    for (const code of issued.codes) expect(serializedAudit).not.toContain(code);
    expect(serializedAudit).not.toContain("verified-test-otp");
  });

  it("rejects wrong codes, other accounts and invalid phone proofs without consuming a code", async () => {
    const userId = await createSyntheticRecoveryUser();
    const otherUserId = await createSyntheticRecoveryUser();
    const service = createRecoveryTestService();
    const issued = await service.issueForSyntheticTest(userId, 2);
    const expiresAt = new Date(Date.now() + 60_000);
    const wrongCode = await service.redeemForSyntheticTest({
      userId,
      attemptId: randomUUID(),
      code: "A".repeat(43),
      otpReceipt: `verified-test-otp:${userId}`,
      capabilityExpiresAt: expiresAt,
    });
    const wrongAccount = await service.redeemForSyntheticTest({
      userId: otherUserId,
      attemptId: randomUUID(),
      code: issued.codes[0] as string,
      otpReceipt: `verified-test-otp:${otherUserId}`,
      capabilityExpiresAt: expiresAt,
    });
    const wrongOtp = await service.redeemForSyntheticTest({
      userId,
      attemptId: randomUUID(),
      code: issued.codes[0] as string,
      otpReceipt: "unverified-test-otp",
      capabilityExpiresAt: expiresAt,
    });
    expect(wrongCode).toEqual({ accepted: false, reason: "invalid" });
    expect(wrongAccount).toEqual({ accepted: false, reason: "invalid" });
    expect(wrongOtp).toEqual({ accepted: false, reason: "invalid" });
    const valid = await service.redeemForSyntheticTest({
      userId,
      attemptId: randomUUID(),
      code: issued.codes[0] as string,
      otpReceipt: `verified-test-otp:${userId}`,
      capabilityExpiresAt: expiresAt,
    });
    expect(valid.accepted).toBe(true);
  });

  it("redeems once, creates only a bound test capability and leaves sessions and membership unchanged", async () => {
    const userId = await createSyntheticRecoveryUser();
    await client`INSERT INTO "organization" ("id", "name", "slug", "created_at") VALUES ('recovery-org', 'Recovery test business', 'recovery-test-business', now())`;
    await client`INSERT INTO "member" ("id", "organization_id", "user_id", "role", "created_at") VALUES ('recovery-member', 'recovery-org', ${userId}, 'owner', now())`;
    await client`INSERT INTO "session" ("id", "expires_at", "token", "created_at", "updated_at", "user_id") VALUES ('recovery-session', now() + interval '1 day', 'recovery-session-token', now(), now(), ${userId})`;
    const service = createRecoveryTestService();
    const issued = await service.issueForSyntheticTest(userId, 1);
    const before = await client`
      SELECT (SELECT count(*)::int FROM "session" WHERE "user_id" = ${userId}) AS sessions,
             (SELECT count(*)::int FROM "member" WHERE "user_id" = ${userId}) AS memberships
    `;
    const attemptId = randomUUID();
    const expiresAt = new Date(Date.now() + 60_000);
    const redeemed = await service.redeemForSyntheticTest({
      userId,
      attemptId,
      code: issued.codes[0] as string,
      otpReceipt: `verified-test-otp:${userId}`,
      capabilityExpiresAt: expiresAt,
    });
    expect(redeemed.accepted).toBe(true);
    if (!redeemed.accepted) throw new Error("Expected synthetic recovery redemption");
    const persistedCapability = await client`
      SELECT "user_id", "attempt_id", "purpose", "scope", "verifier", "key_version"
      FROM "recovery_capability" WHERE "id" = ${redeemed.capabilityId}
    `;
    expect(persistedCapability[0]?.user_id).toBe(userId);
    expect(persistedCapability[0]?.attempt_id).toBe(attemptId);
    expect(persistedCapability[0]?.scope).toBe("recovery_state_only");
    expect(persistedCapability[0]?.verifier).not.toBe(redeemed.capabilityToken);
    expect(JSON.stringify(persistedCapability)).not.toContain(redeemed.capabilityToken);
    const safeAudit =
      await client`SELECT "event", "outcome" FROM "recovery_audit_event" WHERE "user_id" = ${userId}`;
    expect(JSON.stringify(safeAudit)).not.toContain(redeemed.capabilityToken);
    expect(
      await service.inspectRestrictedTestCapability({
        capabilityId: redeemed.capabilityId,
        capabilityToken: redeemed.capabilityToken,
        userId,
        attemptId,
      }),
    ).toBe(true);
    expect(
      await service.inspectRestrictedTestCapability({
        capabilityId: redeemed.capabilityId,
        capabilityToken: redeemed.capabilityToken,
        userId: "another-user",
        attemptId,
      }),
    ).toBe(false);
    expect(
      await service.inspectRestrictedTestCapability({
        capabilityId: redeemed.capabilityId,
        capabilityToken: "C".repeat(43),
        userId,
        attemptId,
      }),
    ).toBe(false);
    expect(
      await service.inspectRestrictedTestCapability({
        capabilityId: redeemed.capabilityId,
        capabilityToken: redeemed.capabilityToken,
        userId,
        attemptId,
        now: new Date(expiresAt.getTime() + 1),
      }),
    ).toBe(false);
    expect(
      await service.consumeRestrictedTestCapability({
        capabilityId: redeemed.capabilityId,
        capabilityToken: redeemed.capabilityToken,
        userId,
        attemptId,
      }),
    ).toBe(true);
    expect(
      await service.consumeRestrictedTestCapability({
        capabilityId: redeemed.capabilityId,
        capabilityToken: redeemed.capabilityToken,
        userId,
        attemptId,
      }),
    ).toBe(false);
    const replay = await service.redeemForSyntheticTest({
      userId,
      attemptId: randomUUID(),
      code: issued.codes[0] as string,
      otpReceipt: `verified-test-otp:${userId}`,
      capabilityExpiresAt: expiresAt,
    });
    expect(replay).toEqual({ accepted: false, reason: "invalid" });
    const after = await client`
      SELECT (SELECT count(*)::int FROM "session" WHERE "user_id" = ${userId}) AS sessions,
             (SELECT count(*)::int FROM "member" WHERE "user_id" = ${userId}) AS memberships
    `;
    expect(after).toEqual(before);
    expect(await currentOwnerSensitiveActionDecision(userId)).toEqual({
      allowed: false,
      reason: "independent_recovery_required",
    });
  });

  it("allows exactly one PostgreSQL redemption when attempts race", async () => {
    const userId = await createSyntheticRecoveryUser();
    const service = createRecoveryTestService();
    const issued = await service.issueForSyntheticTest(userId, 1);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.redeemForSyntheticTest({
          userId,
          attemptId: randomUUID(),
          code: issued.codes[0] as string,
          otpReceipt: `verified-test-otp:${userId}`,
          capabilityExpiresAt: new Date(Date.now() + 60_000),
        }),
      ),
    );
    expect(results.filter((result) => result.accepted)).toHaveLength(1);
    expect(results.filter((result) => !result.accepted)).toHaveLength(7);
    const consumed =
      await client`SELECT count(*)::int AS count FROM "recovery_code" WHERE "user_id" = ${userId} AND "consumed_at" IS NOT NULL`;
    expect(consumed[0]?.count).toBe(1);
  });

  it("rejects repeated attempt IDs and applies explicit account rate limits", async () => {
    const userId = await createSyntheticRecoveryUser();
    const service = createRecoveryTestService({ maxAttempts: 2 });
    const issued = await service.issueForSyntheticTest(userId, 1);
    const attemptId = randomUUID();
    const redeem = (id: string, code: string) =>
      service.redeemForSyntheticTest({
        userId,
        attemptId: id,
        code,
        otpReceipt: `verified-test-otp:${userId}`,
        capabilityExpiresAt: new Date(Date.now() + 60_000),
      });
    expect(await redeem(attemptId, "B".repeat(43))).toEqual({ accepted: false, reason: "invalid" });
    expect(await redeem(attemptId, issued.codes[0] as string)).toEqual({
      accepted: false,
      reason: "invalid",
    });
    expect(await redeem(randomUUID(), "B".repeat(43))).toEqual({
      accepted: false,
      reason: "rate_limited",
    });
  });

  it("invalidates earlier code sets and outstanding capabilities when the synthetic set rotates", async () => {
    const userId = await createSyntheticRecoveryUser();
    const service = createRecoveryTestService();
    const first = await service.issueForSyntheticTest(userId, 1);
    const firstRedemption = await service.redeemForSyntheticTest({
      userId,
      attemptId: randomUUID(),
      code: first.codes[0] as string,
      otpReceipt: `verified-test-otp:${userId}`,
      capabilityExpiresAt: new Date(Date.now() + 60_000),
    });
    if (!firstRedemption.accepted) throw new Error("Expected test capability");
    const second = await service.issueForSyntheticTest(userId, 1);
    expect(second.epoch).toBe(first.epoch + 1);
    expect(
      await service.inspectRestrictedTestCapability({
        capabilityId: firstRedemption.capabilityId,
        capabilityToken: firstRedemption.capabilityToken,
        userId,
        attemptId: String(
          (
            await client`SELECT "attempt_id" FROM "recovery_capability" WHERE "id" = ${firstRedemption.capabilityId}`
          )[0]?.attempt_id,
        ),
      }),
    ).toBe(false);
    expect(
      await service.redeemForSyntheticTest({
        userId,
        attemptId: randomUUID(),
        code: first.codes[0] as string,
        otpReceipt: `verified-test-otp:${userId}`,
        capabilityExpiresAt: new Date(Date.now() + 60_000),
      }),
    ).toEqual({ accepted: false, reason: "invalid" });
    expect(await service.revokeCodeSetsForSyntheticTest(userId)).toBe(1);
    expect(
      await service.redeemForSyntheticTest({
        userId,
        attemptId: randomUUID(),
        code: second.codes[0] as string,
        otpReceipt: `verified-test-otp:${userId}`,
        capabilityExpiresAt: new Date(Date.now() + 60_000),
      }),
    ).toEqual({ accepted: false, reason: "invalid" });
  });

  it("fails closed when a verifier key is absent or its pepper value is corrupted", async () => {
    const userId = await createSyntheticRecoveryUser();
    const oldKey = Buffer.alloc(32, 0x11);
    const issuedByOldKey = createRecoveryTestService({ keyVersion: "key-v1", key: oldKey });
    const issued = await issuedByOldKey.issueForSyntheticTest(userId, 1);
    const input = {
      userId,
      attemptId: randomUUID(),
      code: issued.codes[0] as string,
      otpReceipt: `verified-test-otp:${userId}`,
      capabilityExpiresAt: new Date(Date.now() + 60_000),
    };
    const missingKey = createRecoveryTestService({
      keyVersion: "key-v2",
      key: Buffer.alloc(32, 0x22),
    });
    expect(await missingKey.redeemForSyntheticTest(input)).toEqual({
      accepted: false,
      reason: "invalid",
    });
    const corruptKey = createRecoveryTestService({
      keyVersion: "key-v1",
      key: Buffer.alloc(32, 0x33),
    });
    expect(await corruptKey.redeemForSyntheticTest({ ...input, attemptId: randomUUID() })).toEqual({
      accepted: false,
      reason: "invalid",
    });
    const unused =
      await client`SELECT "consumed_at" FROM "recovery_code" WHERE "user_id" = ${userId}`;
    expect(unused[0]?.consumed_at).toBeNull();
  });

  it("requires a verified existing synthetic phone account for issuance", async () => {
    const userId = await createSyntheticRecoveryUser(false);
    const service = createRecoveryTestService();
    await expect(service.issueForSyntheticTest(userId, 1)).rejects.toThrow(
      "Synthetic verified account required",
    );
    expect(
      (
        await client`SELECT count(*)::int AS count FROM "recovery_code_set" WHERE "user_id" = ${userId}`
      )[0]?.count,
    ).toBe(0);
  });

  it("rejects clients configured for a non-loopback host or a different database before connecting", async () => {
    const misconfiguredClients = [
      postgres("postgres://postgres:postgres@192.0.2.1:5432/mizvo_test", {
        connect_timeout: 1,
      }),
      postgres("postgres://postgres:postgres@127.0.0.1:5432/production", {
        connect_timeout: 1,
      }),
    ];
    try {
      for (const unsafeClient of misconfiguredClients) {
        expect(() => createRecoveryTestService({ client: unsafeClient })).toThrow(
          "loopback connection to mizvo_test",
        );
      }
    } finally {
      await Promise.all(misconfiguredClients.map((unsafeClient) => unsafeClient.end()));
    }
  });

  it("denies ordinary verified phone-first Better Auth accounts despite their placeholder email", async () => {
    const auth = createTestAuth();
    const phoneNumber = `+234803${randomInt(1_000_000, 9_999_999)}`;
    const send = await authRequest(auth, "/phone-number/send-otp", { phoneNumber });
    expect(send.status).toBe(200);
    const verified = await authRequest(auth, "/phone-number/verify", {
      phoneNumber,
      code: deliveries.at(-1)?.code,
    });
    expect(verified.status).toBe(200);

    const [ordinaryUser] = await client`
      SELECT "id", "email", "email_verified", "phone_number_verified"
      FROM "user" WHERE "phone_number" = ${phoneNumber}
    `;
    expect(ordinaryUser?.email).toMatch(/^phone-.+@users\.invalid$/);
    expect(ordinaryUser?.email_verified).toBe(false);
    expect(ordinaryUser?.phone_number_verified).toBe(true);

    const service = createRecoveryTestService();
    await expect(service.issueForSyntheticTest(String(ordinaryUser?.id), 1)).rejects.toThrow(
      "Synthetic verified account required",
    );
    await expect(
      service.redeemForSyntheticTest({
        userId: String(ordinaryUser?.id),
        attemptId: randomUUID(),
        code: "not-a-recovery-code",
        otpReceipt: `verified-test-otp:${String(ordinaryUser?.id)}`,
        capabilityExpiresAt: new Date(Date.now() + 60_000),
      }),
    ).resolves.toEqual({ accepted: false, reason: "invalid" });
    await expect(service.revokeCodeSetsForSyntheticTest(String(ordinaryUser?.id))).rejects.toThrow(
      "Synthetic verified account required",
    );
    await expect(
      service.inspectRestrictedTestCapability({
        capabilityId: randomUUID(),
        capabilityToken: "not-a-capability",
        userId: String(ordinaryUser?.id),
        attemptId: randomUUID(),
      }),
    ).resolves.toBe(false);
    await expect(
      service.consumeRestrictedTestCapability({
        capabilityId: randomUUID(),
        capabilityToken: "not-a-capability",
        userId: String(ordinaryUser?.id),
        attemptId: randomUUID(),
      }),
    ).resolves.toBe(false);

    const rows = await client`
      SELECT
        (SELECT count(*)::int FROM "recovery_test_identity" WHERE "user_id" = ${ordinaryUser?.id}) AS registered,
        (SELECT count(*)::int FROM "recovery_code_set" WHERE "user_id" = ${ordinaryUser?.id}) AS sets,
        (SELECT count(*)::int FROM "recovery_attempt" WHERE "user_id" = ${ordinaryUser?.id}) AS attempts,
        (SELECT count(*)::int FROM "recovery_audit_event" WHERE "user_id" = ${ordinaryUser?.id}) AS audit_events
    `;
    expect(rows[0]).toEqual({ registered: 0, sets: 0, attempts: 0, audit_events: 0 });
  });

  it("rejects deleting or demoting the last owner", async () => {
    const { users } = await seedBusiness();
    await expect(
      client`DELETE FROM "member" WHERE "organization_id" = 'org-test' AND "user_id" = ${users[0]}`,
    ).rejects.toThrow(/retain at least one owner/);
    await expect(
      client`UPDATE "member" SET "role" = 'manager' WHERE "organization_id" = 'org-test' AND "user_id" = ${users[0]}`,
    ).rejects.toThrow(/retain at least one owner/);
  });

  it("prevents moving the last owner to another organization", async () => {
    const { users } = await seedBusiness();
    await client`INSERT INTO "organization" ("id", "name", "slug", "created_at") VALUES ('org-other', 'Other business', 'other-business', now())`;
    await expect(
      client`UPDATE "member" SET "organization_id" = 'org-other' WHERE "organization_id" = 'org-test' AND "user_id" = ${users[0]}`,
    ).rejects.toThrow(/retain at least one owner/);
  });

  it("serializes concurrent removal of two owners and preserves one", async () => {
    const { users } = await seedBusiness(2);
    const removals = await Promise.allSettled([
      client`DELETE FROM "member" WHERE "organization_id" = 'org-test' AND "user_id" = ${users[0]}`,
      client`UPDATE "member" SET "role" = 'manager' WHERE "organization_id" = 'org-test' AND "user_id" = ${users[1]}`,
    ]);
    expect(removals.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(removals.filter((result) => result.status === "rejected")).toHaveLength(1);
    const [{ count }] =
      await client`SELECT count(*)::int AS count FROM "member" WHERE "organization_id" = 'org-test' AND "role" = 'owner'`;
    expect(count).toBe(1);
  });

  it("rejects duplicate memberships and unsupported roles", async () => {
    const { users } = await seedBusiness();
    await expect(
      client`INSERT INTO "member" ("id", "organization_id", "user_id", "role", "created_at") VALUES ('duplicate', 'org-test', ${users[0]}, 'staff', now())`,
    ).rejects.toThrow(/member_organization_user_unique/);
    await expect(
      client`INSERT INTO "member" ("id", "organization_id", "user_id", "role", "created_at") VALUES ('invalid-role', 'org-test', ${users[1]}, 'member', now())`,
    ).rejects.toThrow(/member_role_allowed/);
  });

  it("requires Better Auth member creation to provide a valid Mizvo role", async () => {
    const { users, organizationId } = await seedBusiness();
    const auth = createTestAuth();

    const created = await auth.api.addMember({
      body: { userId: users[1], organizationId, role: "staff" as never },
    });
    expect(created.role).toBe("staff");
    await expect(
      auth.api.addMember({
        body: { userId: users[2], organizationId } as never,
      }),
    ).rejects.toThrow();
    await expect(
      auth.api.addMember({
        body: { userId: users[2], organizationId, role: "member" as "owner" },
      }),
    ).rejects.toThrow();
    const uncreatedMember = await client`SELECT "role" FROM "member" WHERE "user_id" = ${users[2]}`;
    expect(uncreatedMember).toHaveLength(0);
  });

  it("stores phone invitations and their audit trail without retaining bearer tokens or phone numbers", async () => {
    const { users, organizationId } = await seedBusiness();
    const auth = createTestAuth();
    const secret = "invitation-hash-key-for-isolated-test-only";
    const recipientPhone = "+2348031234567";
    await client`UPDATE "user" SET "phone_number" = ${recipientPhone}, "phone_number_verified" = true WHERE "id" = ${users[1]}`;
    await client`INSERT INTO "user" ("id", "name", "email") VALUES ('user-4', 'user-4', 'user-4@example.invalid')`;
    for (const [index, role] of (["manager", "staff", "viewer"] as const).entries()) {
      await auth.api.addMember({
        body: { userId: users[index + 1] ?? "user-4", organizationId, role },
      });
      await expect(
        createPhoneInvitation(auth, {
          organizationId,
          inviterId: users[index + 1] ?? "user-4",
          recipientPhoneNumber: recipientPhone,
          role: "staff",
          phoneHashSecret: secret,
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
    }

    const created = await createPhoneInvitation(auth, {
      organizationId,
      inviterId: users[0] as string,
      recipientPhoneNumber: recipientPhone,
      role: "staff",
      phoneHashSecret: secret,
    });
    expect(created.token).toHaveLength(43);
    expect(created.expiresAt.getTime() - Date.now()).toBeGreaterThan(47 * 60 * 60 * 1000);
    expect(created.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(48 * 60 * 60 * 1000);

    const stored =
      await client`SELECT * FROM "phone_invitation" WHERE "id" = ${created.invitationId}`;
    expect(stored).toHaveLength(1);
    expect(stored[0]?.token_hash).not.toBe(created.token);
    expect(JSON.stringify(stored[0])).not.toContain(recipientPhone);
    expect(stored[0]?.role).toBe("staff");
    const events =
      await client`SELECT "action", "actor_id", "role" FROM "business_audit_event" WHERE "invitation_id" = ${created.invitationId}`;
    expect(events).toEqual([{ action: "invitation.created", actor_id: users[0], role: "staff" }]);
    expect(JSON.stringify(events)).not.toContain(recipientPhone);
    expect(JSON.stringify(events)).not.toContain(created.token);

    await expect(
      createPhoneInvitation(auth, {
        organizationId,
        inviterId: users[1] as string,
        recipientPhoneNumber: recipientPhone,
        role: "manager",
        phoneHashSecret: secret,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      createPhoneInvitation(auth, {
        organizationId,
        inviterId: users[0] as string,
        recipientPhoneNumber: recipientPhone,
        role: "owner",
        phoneHashSecret: secret,
      }),
    ).rejects.toMatchObject({ code: "invalid_invitation" });
  });

  it("accepts only the intended verified phone and records membership atomically", async () => {
    const { users, organizationId } = await seedBusiness();
    const auth = createTestAuth();
    const secret = "invitation-hash-key-for-isolated-test-only";
    await client`UPDATE "user" SET "phone_number" = '+2348031234567', "phone_number_verified" = false WHERE "id" = ${users[1]}`;
    await client`UPDATE "user" SET "phone_number" = '+2348041234567', "phone_number_verified" = true WHERE "id" = ${users[2]}`;

    const invitation = await createPhoneInvitation(auth, {
      organizationId,
      inviterId: users[0] as string,
      recipientPhoneNumber: "+2348031234567",
      role: "viewer",
      phoneHashSecret: secret,
    });
    await expect(
      acceptPhoneInvitation(auth, {
        token: invitation.token,
        recipientUserId: users[2] as string,
        phoneHashSecret: secret,
      }),
    ).rejects.toMatchObject({ code: "invalid_invitation" });

    await expect(
      acceptPhoneInvitation(auth, {
        token: invitation.token,
        recipientUserId: users[1] as string,
        phoneHashSecret: secret,
      }),
    ).rejects.toMatchObject({ code: "invalid_invitation" });
    await client`UPDATE "user" SET "phone_number_verified" = true WHERE "id" = ${users[1]}`;

    const [stillPending] =
      await client`SELECT "status" FROM "phone_invitation" WHERE "id" = ${invitation.invitationId}`;
    expect(stillPending?.status).toBe("pending");
    const accepted = await acceptPhoneInvitation(auth, {
      token: invitation.token,
      recipientUserId: users[1] as string,
      phoneHashSecret: secret,
    });
    expect(accepted).toEqual({ organizationId, role: "viewer" });
    const memberships =
      await client`SELECT "role" FROM "member" WHERE "organization_id" = ${organizationId} AND "user_id" = ${users[1]}`;
    expect(memberships).toEqual([{ role: "viewer" }]);
    await expect(
      acceptPhoneInvitation(auth, {
        token: invitation.token,
        recipientUserId: users[1] as string,
        phoneHashSecret: secret,
      }),
    ).rejects.toMatchObject({ code: "invalid_invitation" });
    const acceptedEvents =
      await client`SELECT "action", "subject_user_id", "role" FROM "business_audit_event" WHERE "invitation_id" = ${invitation.invitationId} ORDER BY "created_at", "action"`;
    expect(acceptedEvents.map(({ action }) => action)).toEqual([
      "invitation.created",
      "invitation.accepted",
    ]);
    expect(acceptedEvents[1]).toMatchObject({ subject_user_id: users[1], role: "viewer" });

    const duplicateMembershipInvite = await createPhoneInvitation(auth, {
      organizationId,
      inviterId: users[0] as string,
      recipientPhoneNumber: "+2348031234567",
      role: "staff",
      phoneHashSecret: secret,
    });
    await expect(
      acceptPhoneInvitation(auth, {
        token: duplicateMembershipInvite.token,
        recipientUserId: users[1] as string,
        phoneHashSecret: secret,
      }),
    ).rejects.toMatchObject({ code: "already_member" });
    const rolledBackDuplicate =
      await client`SELECT "status" FROM "phone_invitation" WHERE "id" = ${duplicateMembershipInvite.invitationId}`;
    expect(rolledBackDuplicate).toEqual([{ status: "pending" }]);
    const duplicateMembershipEvents =
      await client`SELECT "action" FROM "business_audit_event" WHERE "invitation_id" = ${duplicateMembershipInvite.invitationId}`;
    expect(duplicateMembershipEvents.map(({ action }) => action)).toEqual(["invitation.created"]);
  });

  it("serializes parallel invitation redemption and audits only the winning membership", async () => {
    const { users, organizationId } = await seedBusiness();
    const auth = createTestAuth();
    const secret = "invitation-hash-key-for-isolated-test-only";
    const recipientPhone = "+2348031234567";
    await client`UPDATE "user" SET "phone_number" = ${recipientPhone}, "phone_number_verified" = true WHERE "id" = ${users[1]}`;
    const invitation = await createPhoneInvitation(auth, {
      organizationId,
      inviterId: users[0] as string,
      recipientPhoneNumber: recipientPhone,
      role: "manager",
      phoneHashSecret: secret,
    });

    const redemptions = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        acceptPhoneInvitation(auth, {
          token: invitation.token,
          recipientUserId: users[1] as string,
          phoneHashSecret: secret,
        }),
      ),
    );
    expect(redemptions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(redemptions.filter((result) => result.status === "rejected")).toHaveLength(1);
    const members =
      await client`SELECT "role" FROM "member" WHERE "organization_id" = ${organizationId} AND "user_id" = ${users[1]}`;
    expect(members).toEqual([{ role: "manager" }]);
    const events =
      await client`SELECT "action" FROM "business_audit_event" WHERE "invitation_id" = ${invitation.invitationId}`;
    expect(events.map(({ action }) => action).sort()).toEqual([
      "invitation.accepted",
      "invitation.created",
    ]);
  });

  it("revokes invitations within their business, rejects expired tokens, and preserves audit events", async () => {
    const { users, organizationId } = await seedBusiness();
    const auth = createTestAuth();
    const secret = "invitation-hash-key-for-isolated-test-only";
    const recipientPhone = "+2348031234567";
    await client`UPDATE "user" SET "phone_number" = ${recipientPhone}, "phone_number_verified" = true WHERE "id" = ${users[1]}`;
    const revoked = await createPhoneInvitation(auth, {
      organizationId,
      inviterId: users[0] as string,
      recipientPhoneNumber: recipientPhone,
      role: "staff",
      phoneHashSecret: secret,
    });
    await expect(
      client`UPDATE "phone_invitation" SET "role" = 'owner' WHERE "id" = ${revoked.invitationId}`,
    ).rejects.toThrow(/phone_invitation_role_allowed/);
    await expect(
      revokePhoneInvitation(auth, {
        organizationId: "another-business",
        inviterId: users[0] as string,
        invitationId: revoked.invitationId,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await revokePhoneInvitation(auth, {
      organizationId,
      inviterId: users[0] as string,
      invitationId: revoked.invitationId,
    });
    await expect(
      acceptPhoneInvitation(auth, {
        token: revoked.token,
        recipientUserId: users[1] as string,
        phoneHashSecret: secret,
      }),
    ).rejects.toMatchObject({ code: "invalid_invitation" });

    const expired = await createPhoneInvitation(auth, {
      organizationId,
      inviterId: users[0] as string,
      recipientPhoneNumber: recipientPhone,
      role: "staff",
      phoneHashSecret: secret,
    });
    await client`UPDATE "phone_invitation" SET "expires_at" = now() - interval '1 minute' WHERE "id" = ${expired.invitationId}`;
    await expect(
      acceptPhoneInvitation(auth, {
        token: expired.token,
        recipientUserId: users[1] as string,
        phoneHashSecret: secret,
      }),
    ).rejects.toMatchObject({ code: "invalid_invitation" });

    await expect(
      client`UPDATE "business_audit_event" SET "action" = 'invitation.accepted' WHERE "invitation_id" = ${revoked.invitationId}`,
    ).rejects.toThrow(/append-only/);
    await expect(
      client`DELETE FROM "business_audit_event" WHERE "invitation_id" = ${revoked.invitationId}`,
    ).rejects.toThrow(/append-only/);
    const events =
      await client`SELECT "action" FROM "business_audit_event" WHERE "invitation_id" = ${revoked.invitationId} ORDER BY "created_at", "action"`;
    expect(events.map(({ action }) => action).sort()).toEqual([
      "invitation.created",
      "invitation.revoked",
    ]);
  });

  it("keeps invitation and membership HTTP routes closed until C3 evidence exists", async () => {
    const environment = {
      AUTH_ENABLED: "true",
      DATABASE_URL: databaseUrl as string,
      BETTER_AUTH_SECRET: "integration-test-secret-with-at-least-32-chars",
      BETTER_AUTH_URL: "https://auth.mizvo.test",
      BETTER_AUTH_TRUSTED_ORIGINS: "https://app.mizvo.test",
      NODE_ENV: "production",
    };
    const app = buildApp(environment, { smsTransport });
    const origin = "https://app.mizvo.test";
    const register = async (phoneNumber: string) => {
      const requested = await app.inject({
        method: "POST",
        url: "/api/auth/phone-number/send-otp",
        payload: { phoneNumber },
        headers: { origin },
      });
      expect(requested.statusCode).toBe(200);
      const verified = await app.inject({
        method: "POST",
        url: "/api/auth/phone-number/verify",
        payload: { phoneNumber, code: deliveries.at(-1)?.code },
        headers: { origin },
      });
      expect(verified.statusCode).toBe(200);
      const cookies = verified.headers["set-cookie"];
      return Array.isArray(cookies) ? cookies[0]?.split(";", 1)[0] : cookies?.split(";", 1)[0];
    };

    try {
      const ownerCookie = await register("+2348031234567");
      const createdBusiness = await app.inject({
        method: "POST",
        url: "/api/businesses",
        payload: { name: "C2 Guard Business" },
        headers: { origin, cookie: ownerCookie ?? "" },
      });
      expect(createdBusiness.statusCode).toBe(201);
      const businessId = createdBusiness.json<{ business: { id: string } }>().business.id;
      const routes = [
        {
          method: "POST",
          url: "/api/businesses/invitations",
          payload: { phoneNumber: "+2348041234567", role: "staff" },
        },
        { method: "DELETE", url: "/api/businesses/invitations/invite-test" },
        {
          method: "POST",
          url: "/api/businesses/invitations/accept",
          payload: { token: "untrusted" },
        },
        {
          method: "PATCH",
          url: "/api/businesses/members/member-test",
          payload: { role: "manager" },
        },
        { method: "DELETE", url: "/api/businesses/members/member-test" },
        { method: "POST", url: "/api/businesses/ownership/transfer", payload: { userId: "other" } },
      ] as const;

      for (const route of routes) {
        const unauthenticated = await app.inject({
          method: route.method,
          url: route.url,
          ...("payload" in route ? { payload: route.payload } : {}),
          headers: { origin },
        });
        expect(unauthenticated.statusCode).toBe(401);

        const ownerAttempt = await app.inject({
          method: route.method,
          url: route.url,
          ...("payload" in route ? { payload: route.payload } : {}),
          headers: { origin, cookie: ownerCookie ?? "" },
        });
        expect(ownerAttempt.statusCode).toBe(403);
        expect(ownerAttempt.json<{ error: string }>().error).toBe("owner_security_setup_required");
      }

      const invitationRows =
        await client`SELECT count(*)::int AS count FROM "phone_invitation" WHERE "organization_id" = ${businessId}`;
      expect(invitationRows[0]?.count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("blocks every unreviewed Better Auth passkey endpoint at the production Fastify boundary", async () => {
    const app = buildApp(
      {
        AUTH_ENABLED: "true",
        DATABASE_URL: databaseUrl as string,
        BETTER_AUTH_SECRET: "integration-test-secret-with-at-least-32-chars",
        BETTER_AUTH_URL: "https://auth.mizvo.test",
        BETTER_AUTH_TRUSTED_ORIGINS: "https://app.mizvo.test",
        // Even a mistakenly enabled feature flag must not activate production routes.
        MIZVO_PASSKEY_ENROLLMENT: "development",
        MIZVO_RECOVERY_CODES: "development",
        MIZVO_STEP_UP: "development",
        NODE_ENV: "production",
      },
      { smsTransport },
    );
    const routes = [
      ["GET", "/api/auth/passkey/generate-register-options"],
      ["POST", "/api/auth/passkey/verify-registration"],
      ["GET", "/api/auth/passkey/generate-authenticate-options"],
      ["POST", "/api/auth/passkey/verify-authentication"],
      ["GET", "/api/auth/passkey/list-user-passkeys"],
      ["POST", "/api/auth/passkey/delete-passkey"],
      ["POST", "/api/auth/passkey/update-passkey"],
      ["POST", "/api/auth/passkey/future-unreviewed-endpoint"],
      ["POST", "/api/security/step-up"],
      ["POST", "/api/security/step-up/start"],
      ["POST", "/api/security/step-up/verify"],
      ["POST", "/api/security/step-up/challenge"],
      ["POST", "/api/auth/step-up/verify"],
      ["GET", "/api/recovery-codes"],
      ["POST", "/api/recovery-codes/issue"],
      ["POST", "/api/recovery-codes/redeem"],
      ["POST", "/api/auth/recovery-code/issue"],
      ["POST", "/api/auth/recovery-code/redeem"],
      ["POST", "/api/auth/phone-invitations"],
    ] as const;
    try {
      for (const [method, url] of routes) {
        const response = await app.inject({
          method,
          url,
          payload: method === "POST" ? {} : undefined,
          headers: { origin: "https://app.mizvo.test" },
        });
        expect(response.statusCode, `${method} ${url}`).toBe(404);
      }
      expect((await app.inject({ method: "GET", url: "/api/security/passkeys" })).statusCode).toBe(
        404,
      );
    } finally {
      await app.close();
    }
  });

  it("issues local registration options only to a verified session and binds verification to that same user", async () => {
    const app = createDevelopmentPasskeyApp();
    const origin = "http://localhost:3000";
    try {
      const first = await registerThroughApp(app, "+2348031234567");
      const second = await registerThroughApp(app, "+2348041234567");
      expect(first.user.phone_number_verified).toBe(true);

      const initialStatus = await app.inject({
        method: "GET",
        url: "/api/security/passkeys",
        headers: { cookie: first.cookie },
      });
      expect(initialStatus.statusCode).toBe(200);
      expect(initialStatus.json()).toEqual({ passkeys: [] });

      const options = await app.inject({
        method: "GET",
        url: "/api/auth/passkey/generate-register-options",
        headers: { origin, cookie: first.cookie },
      });
      expect(options.statusCode).toBe(200);
      const registrationOptions = options.json<{
        rp: { id: string };
        authenticatorSelection: { userVerification: string };
      }>();
      expect(registrationOptions.rp.id).toBe("localhost");
      expect(registrationOptions.authenticatorSelection.userVerification).toBe("required");
      const challengeCookieHeaders = options.headers["set-cookie"];
      const challengeCookie = (
        Array.isArray(challengeCookieHeaders) ? challengeCookieHeaders : [challengeCookieHeaders]
      )
        .filter((value): value is string => Boolean(value))
        .map((value) => value.split(";", 1)[0])
        .find((value) => value?.startsWith("better-auth.better-auth-passkey="));
      expect(challengeCookie).toBeDefined();

      const wrongUser = await app.inject({
        method: "POST",
        url: "/api/auth/passkey/verify-registration",
        headers: { origin, cookie: `${second.cookie}; ${challengeCookie}` },
        payload: { response: {} },
      });
      expect(wrongUser.statusCode).toBe(401);
      expect(wrongUser.body).not.toContain(first.user.id);
      const replay = await app.inject({
        method: "POST",
        url: "/api/auth/passkey/verify-registration",
        headers: { origin, cookie: `${first.cookie}; ${challengeCookie}` },
        payload: { response: {} },
      });
      expect(replay.statusCode).toBeGreaterThanOrEqual(400);

      const freshChallenge = await app.inject({
        method: "GET",
        url: "/api/auth/passkey/generate-register-options",
        headers: { origin, cookie: first.cookie },
      });
      const freshCookies = freshChallenge.headers["set-cookie"];
      const freshChallengeCookie = (Array.isArray(freshCookies) ? freshCookies : [freshCookies])
        .filter((value): value is string => Boolean(value))
        .map((value) => value.split(";", 1)[0])
        .find((value) => value?.startsWith("better-auth.better-auth-passkey="));
      const wrongOrigin = await app.inject({
        method: "POST",
        url: "/api/auth/passkey/verify-registration",
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie: `${first.cookie}; ${freshChallengeCookie}`,
        },
        payload: { response: {} },
      });
      expect(wrongOrigin.statusCode).toBe(403);

      await client`UPDATE "verification" SET "expires_at" = now() - interval '1 second' WHERE "value" LIKE '%"type":"registration"%'`;
      const expiredChallenge = await app.inject({
        method: "POST",
        url: "/api/auth/passkey/verify-registration",
        headers: { origin, cookie: `${first.cookie}; ${freshChallengeCookie}` },
        payload: { response: {} },
      });
      expect(expiredChallenge.statusCode).toBeGreaterThanOrEqual(400);

      const malformedOptions = await app.inject({
        method: "GET",
        url: "/api/auth/passkey/generate-register-options",
        headers: { origin, cookie: first.cookie },
      });
      const malformedHeaders = malformedOptions.headers["set-cookie"];
      const malformedChallenge = (
        Array.isArray(malformedHeaders) ? malformedHeaders : [malformedHeaders]
      )
        .filter((value): value is string => Boolean(value))
        .map((value) => value.split(";", 1)[0])
        .find((value) => value?.startsWith("better-auth.better-auth-passkey="));
      const malformedResponse = await app.inject({
        method: "POST",
        url: "/api/auth/passkey/verify-registration",
        headers: { origin, cookie: `${first.cookie}; ${malformedChallenge}` },
        payload: { response: {} },
      });
      expect(malformedResponse.statusCode).toBeGreaterThanOrEqual(400);
      expect((await client`SELECT count(*)::int AS count FROM "passkey"`)[0]?.count).toBe(0);

      await client`UPDATE "user" SET "phone_number_verified" = false WHERE "id" = ${first.user.id}`;
      const unverified = await app.inject({
        method: "GET",
        url: "/api/auth/passkey/generate-register-options",
        headers: { origin, cookie: first.cookie },
      });
      expect(unverified.statusCode).toBe(403);

      await client`UPDATE "user" SET "phone_number_verified" = true WHERE "id" = ${first.user.id}`;
      await client`UPDATE "session" SET "expires_at" = now() - interval '1 second' WHERE "user_id" = ${first.user.id}`;
      const expiredSession = await app.inject({
        method: "GET",
        url: "/api/auth/passkey/generate-register-options",
        headers: { origin, cookie: first.cookie },
      });
      expect(expiredSession.statusCode).toBe(401);

      await client`UPDATE "session" SET "expires_at" = now() + interval '1 day' WHERE "user_id" = ${first.user.id}`;
      await client`DELETE FROM "session" WHERE "user_id" = ${first.user.id}`;
      const revoked = await app.inject({
        method: "GET",
        url: "/api/auth/passkey/generate-register-options",
        headers: { origin, cookie: first.cookie },
      });
      expect(revoked.statusCode).toBe(401);

      const accounts = await client`SELECT count(*)::int AS count FROM "user"`;
      expect(accounts[0]?.count).toBe(2);
      const credentialRows = await client`SELECT count(*)::int AS count FROM "passkey"`;
      expect(credentialRows[0]?.count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("enrolls a virtual-authenticator passkey on the same PostgreSQL-backed verified phone identity", async () => {
    const app = createDevelopmentPasskeyApp();
    const browser = await chromium.launch({ headless: true });
    try {
      await app.listen({ host: "127.0.0.1", port: 3000 });
      const context = await browser.newContext();
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send("WebAuthn.enable");
      const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });
      await page.goto("http://localhost:3000/");
      const phoneNumber = "+2348031234567";
      const requestCode = await page.evaluate(async (phone) => {
        const response = await fetch("/api/auth/phone-number/send-otp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ phoneNumber: phone }),
        });
        return response.status;
      }, phoneNumber);
      expect(requestCode).toBe(200);
      const otp = deliveries.at(-1)?.code;
      expect(otp).toMatch(/^\d{6}$/);
      const verifyCode = await page.evaluate(
        async ({ phone, code }) => {
          const response = await fetch("/api/auth/phone-number/verify", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ phoneNumber: phone, code }),
          });
          return response.status;
        },
        { phone: phoneNumber, code: otp },
      );
      expect(verifyCode).toBe(200);

      const userBefore =
        await client`SELECT "id", "phone_number", "phone_number_verified" FROM "user" WHERE "phone_number" = ${phoneNumber}`;
      expect(userBefore).toHaveLength(1);
      const userId = userBefore[0]?.id;
      const sessionsBefore =
        await client`SELECT count(*)::int AS count FROM "session" WHERE "user_id" = ${userId}`;
      expect(sessionsBefore[0]?.count).toBe(1);

      const createRegistrationResponse = async () => {
        await cdp.send("WebAuthn.clearCredentials", { authenticatorId });
        return page.evaluate(async () => {
          const optionsResponse = await fetch("/api/auth/passkey/generate-register-options");
          if (!optionsResponse.ok)
            throw new Error(`registration options failed: ${optionsResponse.status}`);
          const options = await optionsResponse.json();
          const fromBase64url = (value: string) => {
            const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
            const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
            const binary = atob(padded);
            return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
          };
          const toBase64url = (value: ArrayBuffer) => {
            const bytes = new Uint8Array(value);
            let binary = "";
            for (const byte of bytes) binary += String.fromCharCode(byte);
            return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
          };
          const publicKey = {
            ...options,
            challenge: fromBase64url(options.challenge),
            user: { ...options.user, id: fromBase64url(options.user.id) },
            excludeCredentials: (options.excludeCredentials ?? []).map(
              (credential: {
                id: string;
                type: "public-key";
                transports?: AuthenticatorTransport[];
              }) => ({
                ...credential,
                id: fromBase64url(credential.id),
              }),
            ),
          };
          const credential = (await navigator.credentials.create({
            publicKey,
          })) as PublicKeyCredential | null;
          if (!credential) throw new Error("virtual authenticator returned no credential");
          const attestation = credential.response as AuthenticatorAttestationResponse;
          return {
            id: credential.id,
            rawId: toBase64url(credential.rawId),
            type: credential.type as "public-key",
            response: {
              clientDataJSON: toBase64url(attestation.clientDataJSON),
              attestationObject: toBase64url(attestation.attestationObject),
              transports: [...(attestation.getTransports?.() ?? [])],
            },
            clientExtensionResults: credential.getClientExtensionResults() as Record<
              string,
              unknown
            >,
            authenticatorAttachment: credential.authenticatorAttachment as string | null,
          };
        });
      };
      const currentCookieHeader = async () => {
        const cookies = await context.cookies("http://localhost:3000");
        const cookieHeader = cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
        expect(cookieHeader).toContain("better-auth.better-auth-passkey=");
        return cookieHeader;
      };
      const submitRegistration = (response: RegistrationResponse, cookie: string) =>
        app.inject({
          method: "POST",
          url: "/api/auth/passkey/verify-registration",
          headers: { origin: "http://localhost:3000", cookie },
          payload: { response, name: "CI virtual authenticator" },
        });
      const credentialResponse = await createRegistrationResponse();
      const credentialChallengeCookies = await currentCookieHeader();
      const enrolled = await submitRegistration(credentialResponse, credentialChallengeCookies);
      expect(enrolled.statusCode, enrolled.body).toBe(200);

      const replayed = await submitRegistration(credentialResponse, credentialChallengeCookies);
      expect(replayed.statusCode).toBeGreaterThanOrEqual(400);
      expect((await client`SELECT count(*)::int AS count FROM "passkey"`)[0]?.count).toBe(1);

      const challengeMismatch = rewriteClientData(await createRegistrationResponse(), (data) => {
        data.challenge = Buffer.from("attacker-selected-challenge").toString("base64url");
      });
      const challengeMismatchResult = await submitRegistration(
        challengeMismatch,
        await currentCookieHeader(),
      );
      expect(challengeMismatchResult.statusCode).toBeGreaterThanOrEqual(400);
      expect((await client`SELECT count(*)::int AS count FROM "passkey"`)[0]?.count).toBe(1);

      const originMismatch = rewriteClientData(await createRegistrationResponse(), (data) => {
        data.origin = "http://127.0.0.1:3000";
      });
      const originMismatchResult = await submitRegistration(
        originMismatch,
        await currentCookieHeader(),
      );
      expect(originMismatchResult.statusCode).toBeGreaterThanOrEqual(400);
      expect((await client`SELECT count(*)::int AS count FROM "passkey"`)[0]?.count).toBe(1);

      const rpIdMismatch = changeWebAuthnRpIdHash(
        await createRegistrationResponse(),
        "attacker.test",
      );
      const rpIdMismatchResult = await submitRegistration(
        rpIdMismatch,
        await currentCookieHeader(),
      );
      expect(rpIdMismatchResult.statusCode).toBeGreaterThanOrEqual(400);
      expect((await client`SELECT count(*)::int AS count FROM "passkey"`)[0]?.count).toBe(1);

      const missingUserVerification = clearWebAuthnUserVerification(
        await createRegistrationResponse(),
      );
      const missingUserVerificationResult = await submitRegistration(
        missingUserVerification,
        await currentCookieHeader(),
      );
      expect(missingUserVerificationResult.statusCode).toBeGreaterThanOrEqual(400);
      expect((await client`SELECT count(*)::int AS count FROM "passkey"`)[0]?.count).toBe(1);

      const userAfter =
        await client`SELECT "id", "phone_number", "phone_number_verified" FROM "user" WHERE "phone_number" = ${phoneNumber}`;
      expect(userAfter).toEqual(userBefore);
      const credentials =
        await client`SELECT "id", "user_id", "name" FROM "passkey" WHERE "user_id" = ${userId}`;
      expect(credentials).toHaveLength(1);
      expect(credentials[0]?.name).toBe("CI virtual authenticator");
      const sessionsAfter =
        await client`SELECT count(*)::int AS count FROM "session" WHERE "user_id" = ${userId}`;
      expect(sessionsAfter[0]?.count).toBe(sessionsBefore[0]?.count);
      const memberships =
        await client`SELECT count(*)::int AS count FROM "member" WHERE "user_id" = ${userId}`;
      expect(memberships[0]?.count).toBe(0);
      const ownerActions = await page.evaluate(async () => {
        const business = await fetch("/api/businesses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Passkey provisional test" }),
        });
        const attempts = await Promise.all([
          fetch("/api/businesses/invitations", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ phoneNumber: "+2348041234567", role: "staff" }),
          }),
          fetch("/api/businesses/members/member-test", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ role: "manager" }),
          }),
          fetch("/api/businesses/members/member-test", { method: "DELETE" }),
          fetch("/api/businesses/ownership/transfer", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ userId: "attacker-selected-user" }),
          }),
        ]);
        return {
          businessStatus: business.status,
          guards: await Promise.all(
            attempts.map(async (response) => ({
              status: response.status,
              error: (await response.json()).error,
            })),
          ),
        };
      });
      expect(ownerActions.businessStatus).toBe(201);
      expect(ownerActions.guards).toHaveLength(4);
      for (const guard of ownerActions.guards) {
        expect(guard.status).toBe(403);
        expect(guard.error).toBe("owner_security_setup_required");
      }
      const listed = await page.evaluate(async () => {
        const response = await fetch("/api/security/passkeys");
        return { status: response.status, data: await response.json() };
      });
      expect(listed.status).toBe(200);
      expect(listed.data.passkeys).toHaveLength(1);
      expect(JSON.stringify(listed.data)).not.toContain("credentialID");
      expect(userId).toBe(credentials[0]?.user_id);

      // Exercise C3c only through its internal test service. No Fastify or
      // Better Auth authentication-verification route is enabled here.
      const ownedBusiness =
        await client`SELECT organization."id" FROM "organization" INNER JOIN "member" ON "member"."organization_id" = organization."id" WHERE "member"."user_id" = ${userId} AND "member"."role" = 'owner' LIMIT 1`;
      const businessId = ownedBusiness[0]?.id as string | undefined;
      expect(businessId).toBeTruthy();
      if (!businessId || !userId) throw new Error("Expected a business and verified test user");
      await client`
        INSERT INTO "step_up_test_identity" ("user_id", "designation")
        VALUES (${userId}, 'synthetic_fixture')
      `;
      const sessionRows =
        await client`SELECT "id" FROM "session" WHERE "user_id" = ${userId} ORDER BY "created_at" DESC LIMIT 1`;
      const sessionId = sessionRows[0]?.id as string | undefined;
      expect(sessionId).toBeTruthy();
      if (!sessionId) throw new Error("Expected an active test session");
      const stepUp = createStepUpTestService({ client });
      const scope = {
        userId: userId as string,
        sessionId: sessionId as string,
        businessId: businessId as string,
        action: "business.invitation.create",
        target: "synthetic-recipient-member-1",
      };
      const assertionFor = async (
        actionScope = scope,
        mutate?: (response: AuthenticationResponseJSON) => AuthenticationResponseJSON,
      ) => {
        const challenge = await stepUp.startChallenge(actionScope);
        const response = await createAuthenticationResponse(page, challenge.options);
        return {
          challenge,
          response: mutate ? mutate(response) : response,
          result: () =>
            stepUp.verifyAssertion({
              challengeId: challenge.challengeId,
              scope: actionScope,
              response: mutate ? mutate(response) : response,
            }),
        };
      };

      const successfulAssertion = await assertionFor();
      expect(successfulAssertion.challenge.options.userVerification).toBe("required");
      expect(successfulAssertion.challenge.options.rpId).toBe("localhost");
      expect(successfulAssertion.challenge.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
        5 * 60_000,
      );
      const proof = await successfulAssertion.result();
      expect(proof).not.toBeNull();
      if (!proof) throw new Error("Expected a verified assertion to produce test evidence");
      const proofRows = await client`
        SELECT "user_id", "session_id", "business_id", "action", "target_digest",
          "credential_id", "credential_fingerprint", "issued_at", "expires_at", "consumed_at"
        FROM "step_up_proof" WHERE "id" = ${proof.proofId}
      `;
      expect(proofRows).toHaveLength(1);
      expect(proofRows[0]).toMatchObject({
        user_id: userId,
        session_id: sessionId,
        business_id: businessId,
        action: scope.action,
        target_digest: createHash("sha256").update(scope.target).digest("hex"),
        consumed_at: null,
      });
      expect(new Date(proof.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000);
      expect(await stepUp.consumeProof(proof.proofId, { ...scope, target: "other-target" })).toBe(
        false,
      );
      expect(
        await stepUp.consumeProof(proof.proofId, {
          ...scope,
          action: "business.member.remove",
        }),
      ).toBe(false);
      expect(
        await stepUp.consumeProof(proof.proofId, {
          ...scope,
          businessId: "another-business-id",
        }),
      ).toBe(false);
      expect(
        await stepUp.consumeProof(proof.proofId, {
          ...scope,
          sessionId: "another-session-id",
        }),
      ).toBe(false);
      expect(
        await stepUp.consumeProof(proof.proofId, {
          ...scope,
          userId: "another-user-id",
        }),
      ).toBe(false);
      expect(await stepUp.consumeProof(proof.proofId, scope)).toBe(true);
      expect(await stepUp.consumeProof(proof.proofId, scope)).toBe(false);
      expect(await successfulAssertion.result()).toBeNull();
      expect(await currentOwnerSensitiveActionDecision(userId as string)).toEqual({
        allowed: false,
        reason: "independent_recovery_required",
      });

      const ordinaryAccount = await registerThroughApp(app, "+2348041234567");
      const ordinaryUserId = ordinaryAccount.user?.id as string | undefined;
      if (!ordinaryUserId) throw new Error("Expected a second verified phone account");
      await client`
        INSERT INTO "member" ("id", "organization_id", "user_id", "role", "created_at")
        VALUES (${randomUUID()}, ${businessId}, ${ordinaryUserId}, 'owner', now())
      `;
      const ordinarySessionRows =
        await client`SELECT "id" FROM "session" WHERE "user_id" = ${ordinaryUserId} LIMIT 1`;
      await expect(
        stepUp.startChallenge({
          ...scope,
          userId: ordinaryUserId,
          sessionId: ordinarySessionRows[0]?.id as string,
        }),
      ).rejects.toThrow(/synthetic owner/);

      const ownPasskey =
        await client`SELECT "public_key" FROM "passkey" WHERE "user_id" = ${userId} LIMIT 1`;
      const otherCredentialId = "credential-owned-by-another-user";
      await client`
        INSERT INTO "passkey" (
          "id", "name", "public_key", "user_id", "credential_id", "counter",
          "device_type", "backed_up", "created_at"
        ) VALUES (
          ${randomUUID()}, 'foreign synthetic credential fixture', ${ownPasskey[0]?.public_key},
          ${ordinaryUserId}, ${otherCredentialId}, 0, 'singleDevice', false, now()
        )
      `;
      const foreignCredentialChallenge = await stepUp.startChallenge(scope);
      const foreignCredentialResponse = await createAuthenticationResponse(
        page,
        foreignCredentialChallenge.options,
      );
      await client`
        UPDATE "step_up_challenge" SET "credential_id" = ${otherCredentialId}
        WHERE "id" = ${foreignCredentialChallenge.challengeId}
      `;
      expect(
        await stepUp.verifyAssertion({
          challengeId: foreignCredentialChallenge.challengeId,
          scope,
          response: foreignCredentialResponse,
        }),
      ).toBeNull();

      const rejectedAssertions: Array<{
        mutate: (response: AuthenticationResponseJSON) => AuthenticationResponseJSON;
      }> = [
        {
          mutate: (response) =>
            rewriteAssertionClientData(response, (data) => {
              data.challenge = Buffer.from("wrong-challenge").toString("base64url");
            }),
        },
        {
          mutate: (response) =>
            rewriteAssertionClientData(response, (data) => {
              data.origin = "http://127.0.0.1:3000";
            }),
        },
        { mutate: (response) => changeAssertionRpIdHash(response, "attacker.test") },
        { mutate: clearAssertionUserVerification },
        { mutate: alterAssertionSignature },
        {
          mutate: (response) => ({
            ...response,
            id: "other-user-credential-id",
            rawId: Buffer.from("other-user-credential-id").toString("base64url"),
          }),
        },
      ];
      for (const rejected of rejectedAssertions) {
        const candidate = await assertionFor(scope, rejected.mutate);
        expect(await candidate.result()).toBeNull();
      }

      const mismatchedScope = await assertionFor({ ...scope, target: "substituted-target" });
      expect(
        await stepUp.verifyAssertion({
          challengeId: mismatchedScope.challenge.challengeId,
          scope,
          response: mismatchedScope.response,
        }),
      ).toBeNull();

      const expiredChallenge = await stepUp.startChallenge(scope);
      await client`
        UPDATE "step_up_challenge"
        SET "created_at" = now() - interval '6 minutes', "expires_at" = now() - interval '1 minute'
        WHERE "id" = ${expiredChallenge.challengeId}
      `;
      const expiredResponse = await createAuthenticationResponse(page, expiredChallenge.options);
      expect(
        await stepUp.verifyAssertion({
          challengeId: expiredChallenge.challengeId,
          scope,
          response: expiredResponse,
        }),
      ).toBeNull();

      const counterRace = await stepUp.startChallenge(scope);
      const counterRaceResponse = await createAuthenticationResponse(page, counterRace.options);
      const beforeCounterRace =
        await client`SELECT "counter" FROM "passkey" WHERE "user_id" = ${userId} LIMIT 1`;
      const oldCounter = beforeCounterRace[0]?.counter as number;
      await client`UPDATE "passkey" SET "counter" = ${oldCounter + 50} WHERE "user_id" = ${userId}`;
      expect(
        await stepUp.verifyAssertion({
          challengeId: counterRace.challengeId,
          scope,
          response: counterRaceResponse,
        }),
      ).toBeNull();
      await client`UPDATE "passkey" SET "counter" = ${oldCounter} WHERE "user_id" = ${userId}`;

      const roleRevocation = await assertionFor();
      const roleProof = await roleRevocation.result();
      await client`UPDATE "member" SET "role" = 'manager' WHERE "organization_id" = ${businessId} AND "user_id" = ${userId}`;
      expect(await stepUp.consumeProof(roleProof?.proofId as string, scope)).toBe(false);
      await client`UPDATE "member" SET "role" = 'owner' WHERE "organization_id" = ${businessId} AND "user_id" = ${userId}`;
      expect(await stepUp.consumeProof(roleProof?.proofId as string, scope)).toBe(false);

      const membershipRevocation = await assertionFor();
      const membershipProof = await membershipRevocation.result();
      await client`DELETE FROM "member" WHERE "organization_id" = ${businessId} AND "user_id" = ${userId}`;
      expect(await stepUp.consumeProof(membershipProof?.proofId as string, scope)).toBe(false);
      await client`
        INSERT INTO "member" ("id", "organization_id", "user_id", "role", "created_at")
        VALUES (${randomUUID()}, ${businessId}, ${userId}, 'owner', now())
      `;
      expect(await stepUp.consumeProof(membershipProof?.proofId as string, scope)).toBe(false);

      const epochRevocation = await assertionFor();
      const epochProof = await epochRevocation.result();
      const epochBefore =
        await client`SELECT "security_epoch" FROM "step_up_test_identity" WHERE "user_id" = ${userId}`;
      expect(await stepUp.advanceSyntheticSecurityEpoch(userId as string)).toBe(
        (epochBefore[0]?.security_epoch as number) + 1,
      );
      expect(await stepUp.consumeProof(epochProof?.proofId as string, scope)).toBe(false);

      const recoveryRevocation = await assertionFor();
      const recoveryProof = await recoveryRevocation.result();
      await client`
        INSERT INTO "recovery_audit_event" ("id", "user_id", "event", "outcome")
        VALUES (${randomUUID()}, ${userId}, 'redemption_attempted', 'invalid_code')
      `;
      expect(await stepUp.consumeProof(recoveryProof?.proofId as string, scope)).toBe(false);

      const sessionRevocation = await assertionFor();
      const sessionProof = await sessionRevocation.result();
      const sessionExpiry =
        await client`SELECT "expires_at" FROM "session" WHERE "id" = ${sessionId}`;
      const originalSessionExpiry = sessionExpiry[0]?.expires_at;
      if (!originalSessionExpiry) throw new Error("Expected the test session to exist");
      await client`UPDATE "session" SET "expires_at" = now() - interval '1 minute' WHERE "id" = ${sessionId}`;
      expect(await stepUp.consumeProof(sessionProof?.proofId as string, scope)).toBe(false);
      await client`UPDATE "session" SET "expires_at" = ${originalSessionExpiry} WHERE "id" = ${sessionId}`;

      const expiredSessionChallenge = await stepUp.startChallenge(scope);
      const expiredSessionAssertion = await createAuthenticationResponse(
        page,
        expiredSessionChallenge.options,
      );
      await client`UPDATE "session" SET "expires_at" = now() - interval '1 minute' WHERE "id" = ${sessionId}`;
      expect(
        await stepUp.verifyAssertion({
          challengeId: expiredSessionChallenge.challengeId,
          scope,
          response: expiredSessionAssertion,
        }),
      ).toBeNull();
      await client`UPDATE "session" SET "expires_at" = ${originalSessionExpiry} WHERE "id" = ${sessionId}`;

      const expiredProof = await assertionFor();
      const expiringProof = await expiredProof.result();
      if (!expiringProof) throw new Error("Expected evidence to expire in the test");
      await client`
        UPDATE "step_up_proof" SET "issued_at" = now() - interval '11 minutes',
          "expires_at" = now() - interval '1 minute' WHERE "id" = ${expiringProof.proofId}
      `;
      expect(await stepUp.consumeProof(expiringProof.proofId, scope)).toBe(false);

      const concurrent = await stepUp.startChallenge(scope);
      const concurrentResponse = await createAuthenticationResponse(page, concurrent.options);
      const concurrentResults = await Promise.all([
        stepUp.verifyAssertion({
          challengeId: concurrent.challengeId,
          scope,
          response: concurrentResponse,
        }),
        stepUp.verifyAssertion({
          challengeId: concurrent.challengeId,
          scope,
          response: concurrentResponse,
        }),
      ]);
      expect(concurrentResults.filter(Boolean)).toHaveLength(1);

      const revocableChallenge = await stepUp.startChallenge(scope);
      const revocableResponse = await createAuthenticationResponse(
        page,
        revocableChallenge.options,
      );
      const revocableProof = await stepUp.verifyAssertion({
        challengeId: revocableChallenge.challengeId,
        scope,
        response: revocableResponse,
      });
      if (!revocableProof) throw new Error("Expected revocation fixture proof");

      const challengeCount =
        await client`SELECT count(*)::int AS count FROM "step_up_challenge" WHERE "user_id" = ${userId} AND "created_at" > now() - interval '5 minutes'`;
      const neededChallenges = Math.max(0, 31 - (challengeCount[0]?.count ?? 0));
      const identityRows =
        await client`SELECT "security_epoch" FROM "step_up_test_identity" WHERE "user_id" = ${userId}`;
      const challengeSnapshot = await client`
        SELECT "credential_id", "credential_fingerprint", "credential_counter"
        FROM "step_up_challenge" WHERE "id" = ${revocableChallenge.challengeId}
      `;
      for (let index = 0; index < neededChallenges; index++) {
        await client`
          INSERT INTO "step_up_challenge" (
            "id", "challenge_hash", "user_id", "session_id", "business_id", "credential_id",
            "credential_fingerprint", "credential_counter", "membership_role", "action",
            "target_digest", "security_epoch", "recovery_activity_count", "created_at", "expires_at"
          ) VALUES (
            ${randomUUID()}, ${createHash("sha256").update(randomUUID()).digest("hex")},
            ${userId}, ${sessionId}, ${businessId}, ${challengeSnapshot[0]?.credential_id},
            ${challengeSnapshot[0]?.credential_fingerprint}, ${challengeSnapshot[0]?.credential_counter},
            'owner', 'business.invitation.create', ${createHash("sha256").update(scope.target).digest("hex")},
            ${identityRows[0]?.security_epoch},
            (SELECT count(*)::int FROM "recovery_audit_event" WHERE "user_id" = ${userId}),
            now(), now() + interval '4 minutes'
          )
        `;
      }
      await expect(stepUp.startChallenge(scope)).rejects.toThrow(/rate limit/i);

      await client`DELETE FROM "passkey" WHERE "user_id" = ${userId}`;
      expect(await stepUp.consumeProof(revocableProof.proofId, scope)).toBe(false);
      expect(
        await stepUp.verifyAssertion({
          challengeId: revocableChallenge.challengeId,
          scope,
          response: revocableResponse,
        }),
      ).toBeNull();

      const noStepUpRoutes = await Promise.all([
        app.inject({ method: "POST", url: "/api/security/step-up" }),
        app.inject({ method: "POST", url: "/api/security/step-up/start" }),
        app.inject({ method: "POST", url: "/api/auth/passkey/verify-authentication" }),
      ]);
      expect(noStepUpRoutes.map((response) => response.statusCode)).toEqual([404, 404, 404]);

      await context.close();
    } finally {
      await browser.close();
      await app.close();
    }
  }, 120_000);

  it("lists only the authenticated account's safe passkey status and enforces unique credential IDs", async () => {
    const app = createDevelopmentPasskeyApp();
    try {
      const first = await registerThroughApp(app, "+2348031234567");
      const second = await registerThroughApp(app, "+2348041234567");
      await client`INSERT INTO "passkey" ("id", "name", "public_key", "user_id", "credential_id", "counter", "device_type", "backed_up", "created_at") VALUES ('second-passkey', 'Other account secret label', 'sensitive-public-key', ${second.user.id}, 'unique-credential', 0, 'singleDevice', false, now())`;
      const firstList = await app.inject({
        method: "GET",
        url: "/api/security/passkeys",
        headers: { cookie: first.cookie },
      });
      expect(firstList.statusCode).toBe(200);
      expect(firstList.json()).toEqual({ passkeys: [] });

      const ownList = await app.inject({
        method: "GET",
        url: "/api/security/passkeys",
        headers: { cookie: second.cookie },
      });
      expect(ownList.statusCode).toBe(200);
      expect(ownList.body).toContain("second-passkey");
      expect(ownList.body).not.toContain("sensitive-public-key");
      expect(ownList.body).not.toContain("unique-credential");

      const competing = await Promise.allSettled([
        client`INSERT INTO "passkey" ("id", "name", "public_key", "user_id", "credential_id", "counter", "device_type", "backed_up", "created_at") VALUES ('competing-one', 'one', 'key-one', ${first.user.id}, 'racing-credential', 0, 'singleDevice', false, now())`,
        client`INSERT INTO "passkey" ("id", "name", "public_key", "user_id", "credential_id", "counter", "device_type", "backed_up", "created_at") VALUES ('competing-two', 'two', 'key-two', ${second.user.id}, 'racing-credential', 0, 'singleDevice', false, now())`,
      ]);
      expect(competing.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(competing.filter((result) => result.status === "rejected")).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("rejects any passkey registration that lacks verified user presence or same-user verified phone state", () => {
    expect(() =>
      requireVerifiedPasskeyEnrollment({
        userVerified: false,
        sessionUserId: "same-user",
        targetUserId: "same-user",
        phoneNumberVerified: true,
      }),
    ).toThrow(/verified current account/);
    expect(() =>
      requireVerifiedPasskeyEnrollment({
        userVerified: true,
        sessionUserId: "current-user",
        targetUserId: "attacker-selected-user",
        phoneNumberVerified: true,
      }),
    ).toThrow(/verified current account/);
    expect(() =>
      requireVerifiedPasskeyEnrollment({
        userVerified: true,
        sessionUserId: "same-user",
        targetUserId: "same-user",
        phoneNumberVerified: false,
      }),
    ).toThrow(/verified current account/);
    expect(
      requireVerifiedPasskeyEnrollment({
        userVerified: true,
        sessionUserId: "same-user",
        targetUserId: "same-user",
        phoneNumberVerified: true,
      }),
    ).toBe("same-user");
  });

  it("documents the current owner guard by rejecting organization cascade deletion", async () => {
    await seedBusiness();
    await expect(client`DELETE FROM "organization" WHERE "id" = 'org-test'`).rejects.toThrow(
      /retain at least one owner/,
    );
  });

  it("creates a phone-only account after OTP verification and signs the same identity in later", async () => {
    const auth = createTestAuth();
    const phoneNumber = "+2348031234567";
    const send = await authRequest(auth, "/phone-number/send-otp", { phoneNumber });
    expect(send.status).toBe(200);
    expect(deliveries).toHaveLength(1);
    expect(await send.clone().text()).not.toContain(deliveries[0]?.code);

    const verify = await authRequest(auth, "/phone-number/verify", {
      phoneNumber,
      code: deliveries[0]?.code,
    });
    expect(verify.status).toBe(200);
    expect(verify.headers.getSetCookie().join(";")).toMatch(/HttpOnly/i);
    expect(verify.headers.getSetCookie().join(";")).toMatch(/Secure/i);
    expect(verify.headers.getSetCookie().join(";")).toMatch(/SameSite=Lax/i);
    const created =
      await client`SELECT "id", "email", "email_verified", "phone_number_verified" FROM "user" WHERE "phone_number" = ${phoneNumber}`;
    expect(created).toHaveLength(1);
    expect(created[0]?.email).toMatch(/^phone-.+@users\.invalid$/);
    expect(created[0]?.email_verified).toBe(false);
    expect(created[0]?.phone_number_verified).toBe(true);

    const userId = created[0]?.id;
    const [{ expires_at: expiresAt, created_at: createdAt }] =
      await client`SELECT "expires_at", "created_at" FROM "session" WHERE "user_id" = ${userId}`;
    expect(new Date(expiresAt).getTime() - new Date(createdAt).getTime()).toBeLessThanOrEqual(
      7 * 24 * 60 * 60 * 1000 + 1000,
    );

    const cookie = verify.headers.getSetCookie()[0]?.split(";", 1)[0];
    const refreshedSession = await authRequest(auth, "/get-session", undefined, cookie);
    expect(refreshedSession.status).toBe(200);
    const sessionBefore =
      await client`SELECT "expires_at" FROM "session" WHERE "user_id" = ${userId}`;
    await authRequest(auth, "/get-session", undefined, cookie);
    const sessionAfter =
      await client`SELECT "expires_at" FROM "session" WHERE "user_id" = ${userId}`;
    expect(sessionAfter[0]?.expires_at).toEqual(sessionBefore[0]?.expires_at);
    await client`UPDATE "session" SET "expires_at" = now() - interval '1 second' WHERE "user_id" = ${userId}`;
    const expiredSession = await authRequest(auth, "/get-session", undefined, cookie);
    expect(await expiredSession.text()).toBe("null");

    await authRequest(auth, "/phone-number/send-otp", { phoneNumber });
    const secondCode = deliveries[1]?.code;
    const secondVerification = await authRequest(auth, "/phone-number/verify", {
      phoneNumber,
      code: secondCode,
    });
    expect(secondVerification.status).toBe(200);
    const secondCookie = secondVerification.headers.getSetCookie()[0]?.split(";", 1)[0];
    const signedOut = await authRequest(auth, "/sign-out", {}, secondCookie);
    expect(signedOut.status).toBe(200);
    expect(await (await authRequest(auth, "/get-session", undefined, secondCookie)).text()).toBe(
      "null",
    );
    const duplicates =
      await client`SELECT count(*)::int AS count FROM "user" WHERE "phone_number" = ${phoneNumber}`;
    expect(duplicates[0]?.count).toBe(1);
  });

  it("cannot send or verify a new account OTP when delivery provider selection is omitted", async () => {
    const database = createDatabase(databaseUrl as string);
    authDatabases.push(database);
    const auth = createAuth(
      {
        DATABASE_URL: databaseUrl,
        BETTER_AUTH_SECRET: "integration-test-secret-with-at-least-32-chars",
        BETTER_AUTH_URL: "https://auth.mizvo.test",
        BETTER_AUTH_TRUSTED_ORIGINS: "https://app.mizvo.test",
        NODE_ENV: "production",
      },
      { database },
    );

    const send = await authRequest(auth, "/phone-number/send-otp", {
      phoneNumber: "+2348031234567",
    });
    expect(send.status).toBeGreaterThanOrEqual(400);
    const publicError = await send.text();
    expect(publicError).not.toMatch(/\b\d{6}\b/);

    const storedVerification =
      await client`SELECT "value" FROM "verification" WHERE "identifier" = '+2348031234567'`;
    const storedCode = storedVerification[0]?.value.match(/^(\d{6}):/)?.[1];
    const rejectedCode = storedCode === "000000" ? "000001" : "000000";

    const verify = await authRequest(auth, "/phone-number/verify", {
      phoneNumber: "+2348031234567",
      code: rejectedCode,
    });
    expect(verify.status).toBeGreaterThanOrEqual(400);
    const created = await client`SELECT "id" FROM "user" WHERE "phone_number" = '+2348031234567'`;
    expect(created).toHaveLength(0);
  });

  it("rejects invalid, expired, wrong, exhausted, replayed, and concurrent phone codes", async () => {
    const auth = createTestAuth();
    const phoneNumber = "+2348031234567";
    const invalidNumber = await authRequest(auth, "/phone-number/send-otp", {
      phoneNumber: "+14155552671",
    });
    expect(invalidNumber.status).toBeGreaterThanOrEqual(400);
    expect(deliveries).toHaveLength(0);

    await authRequest(auth, "/phone-number/send-otp", { phoneNumber });
    const code = deliveries[0]?.code ?? "000000";
    const wrongRecipient = await authRequest(auth, "/phone-number/verify", {
      phoneNumber: "+2348041234567",
      code,
    });
    expect(wrongRecipient.status).toBeGreaterThanOrEqual(400);
    expect(deliveries).toHaveLength(1);
    const wrongCode = code === "000000" ? "000001" : "000000";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const rejected = await authRequest(auth, "/phone-number/verify", {
        phoneNumber,
        code: wrongCode,
      });
      expect(rejected.status).toBeGreaterThanOrEqual(400);
    }
    const exhausted =
      await client`SELECT "identifier" FROM "verification" WHERE "identifier" = ${phoneNumber}`;
    expect(exhausted).toHaveLength(0);
    const afterExhaustion = await authRequest(auth, "/phone-number/verify", { phoneNumber, code });
    expect(afterExhaustion.status).toBeGreaterThanOrEqual(400);

    await authRequest(auth, "/phone-number/send-otp", { phoneNumber });
    const replayCode = deliveries[1]?.code ?? "000000";
    const first = await authRequest(auth, "/phone-number/verify", {
      phoneNumber,
      code: replayCode,
    });
    const replay = await authRequest(auth, "/phone-number/verify", {
      phoneNumber,
      code: replayCode,
    });
    expect(first.status).toBe(200);
    expect(replay.status).toBeGreaterThanOrEqual(400);

    await authRequest(auth, "/phone-number/send-otp", { phoneNumber: "+2348041234567" });
    const expiresPhone = "+2348041234567";
    await client`UPDATE "verification" SET "expires_at" = now() - interval '1 second' WHERE "identifier" = ${expiresPhone}`;
    const expired = await authRequest(auth, "/phone-number/verify", {
      phoneNumber: expiresPhone,
      code: deliveries[2]?.code,
    });
    expect(expired.status).toBeGreaterThanOrEqual(400);

    await authRequest(auth, "/phone-number/send-otp", { phoneNumber: "+2348051234567" });
    const concurrentPhone = "+2348051234567";
    const concurrentCode = deliveries[3]?.code;
    const concurrent = await Promise.all([
      authRequest(auth, "/phone-number/verify", {
        phoneNumber: concurrentPhone,
        code: concurrentCode,
      }),
      authRequest(auth, "/phone-number/verify", {
        phoneNumber: concurrentPhone,
        code: concurrentCode,
      }),
    ]);
    expect(concurrent.filter((response) => response.status === 200)).toHaveLength(1);
    expect(concurrent.filter((response) => response.status !== 200)).toHaveLength(1);
  });

  it("fails closed on sender failure and enforces durable OTP request limits by phone and IP", async () => {
    const failing: SmsTransport = {
      async sendVerificationCode() {
        throw new Error("provider secret and OTP must not be returned");
      },
    };
    const failingDatabase = createDatabase(databaseUrl as string);
    authDatabases.push(failingDatabase);
    const failingAuth = createAuth(
      {
        DATABASE_URL: databaseUrl,
        BETTER_AUTH_SECRET: "integration-test-secret-with-at-least-32-chars",
        BETTER_AUTH_URL: "https://auth.mizvo.test",
        BETTER_AUTH_TRUSTED_ORIGINS: "https://app.mizvo.test",
        NODE_ENV: "production",
      },
      { database: failingDatabase, smsTransport: failing },
    );
    const failed = await authRequest(failingAuth, "/phone-number/send-otp", {
      phoneNumber: "+2348031234567",
    });
    expect(failed.status).toBeGreaterThanOrEqual(400);
    const publicError = await failed.text();
    expect(publicError).not.toContain("provider secret");
    expect(publicError).not.toContain("OTP must not be returned");
    const unverified =
      await client`SELECT "id" FROM "user" WHERE "phone_number" = '+2348031234567'`;
    expect(unverified).toHaveLength(0);

    const allowed = await Promise.all(
      Array.from({ length: 8 }, () =>
        otpRateLimiter.consume("request", "+2348061234567", "192.0.2.42"),
      ),
    );
    expect(allowed.filter(Boolean)).toHaveLength(3);
    expect(allowed.filter((value) => !value)).toHaveLength(5);
    const anotherNumber = await otpRateLimiter.consume("request", "+2348071234567", "192.0.2.43");
    expect(anotherNumber).toBe(true);
    const verificationAttempts = await Promise.all(
      Array.from({ length: 11 }, () =>
        otpRateLimiter.consume("verify", "+2348081234567", "192.0.2.45"),
      ),
    );
    expect(verificationAttempts.filter(Boolean)).toHaveLength(10);
    expect(verificationAttempts.filter((value) => !value)).toHaveLength(1);
    const ipAttempts = await Promise.all(
      Array.from({ length: 21 }, () => otpRateLimiter.consume("request", null, "192.0.2.44")),
    );
    expect(ipAttempts.filter(Boolean)).toHaveLength(20);
    expect(ipAttempts.filter((value) => !value)).toHaveLength(1);
  });

  it("resets a fixed OTP throttle window after expiry and removes stale buckets", async () => {
    let timestamp = Date.now();
    const rateLimiter = createPostgresOtpRateLimiter(
      postgres(databaseUrl as string, { max: 2, prepare: false }),
      { now: () => timestamp },
    );

    try {
      const initialAttempts = await Promise.all(
        Array.from({ length: 4 }, () =>
          rateLimiter.consume("request", "+2348091234567", "192.0.2.50"),
        ),
      );
      expect(initialAttempts.filter(Boolean)).toHaveLength(3);
      expect(initialAttempts.filter((value) => !value)).toHaveLength(1);
      expect(await rateLimiter.consume("request", "+2348101234567", "192.0.2.51")).toBe(true);

      timestamp += 14 * 60 * 1000;
      expect(await rateLimiter.consume("request", "+2348091234567", "192.0.2.50")).toBe(false);

      timestamp += 60 * 1000;
      expect(await rateLimiter.consume("request", "+2348091234567", "192.0.2.50")).toBe(true);
      const staleBuckets = await client<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM "rate_limit"
        WHERE "key" LIKE 'mizvo:otp:%'
          AND "last_request" <= ${timestamp - 15 * 60 * 1000}
      `;
      expect(staleBuckets[0]?.count).toBe(0);
    } finally {
      await rateLimiter.close();
    }
  });

  it("enforces trusted browser origins at Fastify and forwards protected cookies through the same-origin API", async () => {
    const environment = {
      AUTH_ENABLED: "true",
      DATABASE_URL: databaseUrl as string,
      BETTER_AUTH_SECRET: "integration-test-secret-with-at-least-32-chars",
      BETTER_AUTH_URL: "https://auth.mizvo.test",
      BETTER_AUTH_TRUSTED_ORIGINS: "https://app.mizvo.test",
      NODE_ENV: "production",
    };
    const app = buildApp(environment, { smsTransport });
    const blocked = await app.inject({
      method: "POST",
      url: "/api/auth/phone-number/send-otp",
      payload: { phoneNumber: "+2348031234567" },
      headers: { origin: "https://attacker.example" },
    });
    expect(blocked.statusCode).toBe(403);
    expect(deliveries).toHaveLength(0);

    const requested = await app.inject({
      method: "POST",
      url: "/api/auth/phone-number/send-otp",
      payload: { phoneNumber: "+2348031234567" },
      headers: { origin: "https://app.mizvo.test" },
    });
    expect(requested.statusCode).toBe(200);
    expect(requested.body).not.toContain(deliveries.at(-1)?.code);
    const verified = await app.inject({
      method: "POST",
      url: "/api/auth/phone-number/verify",
      payload: { phoneNumber: "+2348031234567", code: deliveries.at(-1)?.code },
      headers: { origin: "https://app.mizvo.test" },
    });
    expect(verified.statusCode).toBe(200);
    const cookie = verified.headers["set-cookie"];
    const cookieHeader = Array.isArray(cookie)
      ? cookie[0]?.split(";", 1)[0]
      : cookie?.split(";", 1)[0];
    const cookies = Array.isArray(cookie) ? cookie : [cookie ?? ""];
    expect(
      cookies.some(
        (value) =>
          value.includes("HttpOnly") && value.includes("Secure") && value.includes("SameSite=Lax"),
      ),
    ).toBe(true);
    const signedOut = await app.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      payload: {},
      headers: { origin: "https://app.mizvo.test", cookie: cookieHeader ?? "" },
    });
    expect(signedOut.statusCode).toBe(200);
    await app.close();
  });

  it("creates businesses for verified identities and rechecks membership when switching", async () => {
    const environment = {
      AUTH_ENABLED: "true",
      DATABASE_URL: databaseUrl as string,
      BETTER_AUTH_SECRET: "integration-test-secret-with-at-least-32-chars",
      BETTER_AUTH_URL: "https://auth.mizvo.test",
      BETTER_AUTH_TRUSTED_ORIGINS: "https://app.mizvo.test",
      NODE_ENV: "production",
    };
    const app = buildApp(environment, { smsTransport });
    const origin = "https://app.mizvo.test";
    const register = async (phoneNumber: string) => {
      const requested = await app.inject({
        method: "POST",
        url: "/api/auth/phone-number/send-otp",
        payload: { phoneNumber },
        headers: { origin },
      });
      expect(requested.statusCode).toBe(200);
      const verified = await app.inject({
        method: "POST",
        url: "/api/auth/phone-number/verify",
        payload: { phoneNumber, code: deliveries.at(-1)?.code },
        headers: { origin },
      });
      expect(verified.statusCode).toBe(200);
      const cookie = verified.headers["set-cookie"];
      return Array.isArray(cookie) ? cookie[0]?.split(";", 1)[0] : cookie?.split(";", 1)[0];
    };

    try {
      const unauthenticated = await app.inject({
        method: "POST",
        url: "/api/businesses",
        payload: { name: "No session" },
        headers: { origin },
      });
      expect(unauthenticated.statusCode).toBe(401);

      const ownerCookie = await register("+2348031234567");
      const deniedOrigin = await app.inject({
        method: "POST",
        url: "/api/businesses",
        payload: { name: "Origin attack" },
        headers: { origin: "https://attacker.example", cookie: ownerCookie ?? "" },
      });
      expect(deniedOrigin.statusCode).toBe(403);
      const first = await app.inject({
        method: "POST",
        url: "/api/businesses",
        payload: { name: "First Shop" },
        headers: { origin, cookie: ownerCookie ?? "" },
      });
      expect(first.statusCode).toBe(201);
      const firstBusiness = first.json<{ business: { id: string; role: string } }>().business;
      expect(firstBusiness.role).toBe("owner");

      const second = await app.inject({
        method: "POST",
        url: "/api/businesses",
        payload: { name: "Second Shop" },
        headers: { origin, cookie: ownerCookie ?? "" },
      });
      expect(second.statusCode).toBe(201);
      const secondId = second.json<{ business: { id: string } }>().business.id;
      const ownership = await client`
        SELECT m."role", count(*) OVER ()::int AS total
        FROM "member" m
        JOIN "organization" o ON o."id" = m."organization_id"
        WHERE o."id" = ${secondId}
      `;
      expect(ownership).toHaveLength(1);
      expect(ownership[0]?.role).toBe("owner");
      expect(ownership[0]?.total).toBe(1);

      const duplicate = await app.inject({
        method: "POST",
        url: "/api/businesses",
        payload: { name: "Second Shop" },
        headers: { origin, cookie: ownerCookie ?? "" },
      });
      expect(duplicate.statusCode).toBe(409);
      const parallelCreates = await Promise.all(
        Array.from({ length: 2 }, () =>
          app.inject({
            method: "POST",
            url: "/api/businesses",
            payload: { name: "Concurrent Shop" },
            headers: { origin, cookie: ownerCookie ?? "" },
          }),
        ),
      );
      expect(parallelCreates.map((response) => response.statusCode).sort()).toEqual([201, 409]);
      const concurrentBusiness = parallelCreates.find((response) => response.statusCode === 201);
      if (!concurrentBusiness) throw new Error("No concurrent business creation succeeded");
      const concurrentBusinessId = concurrentBusiness.json<{ business: { id: string } }>().business
        .id;
      const concurrentOwners = await client`
        SELECT "role" FROM "member" WHERE "organization_id" = ${concurrentBusinessId}
      `;
      expect(concurrentOwners).toEqual([{ role: "owner" }]);
      const list = await app.inject({
        method: "GET",
        url: "/api/businesses",
        headers: { cookie: ownerCookie ?? "" },
      });
      expect(list.json<{ businesses: unknown[] }>().businesses).toHaveLength(3);
      const switched = await app.inject({
        method: "PUT",
        url: "/api/businesses/active",
        payload: { organizationId: firstBusiness.id },
        headers: { origin, cookie: ownerCookie ?? "" },
      });
      expect(switched.statusCode).toBe(200);
      expect(switched.json<{ activeBusinessId: string }>().activeBusinessId).toBe(firstBusiness.id);
      const activeSession = await app.inject({
        method: "GET",
        url: "/api/auth/get-session",
        headers: { cookie: ownerCookie ?? "" },
      });
      expect(
        activeSession.json<{ session: { activeOrganizationId: string } }>().session
          .activeOrganizationId,
      ).toBe(firstBusiness.id);

      const rawOrganizationEndpoint = await app.inject({
        method: "POST",
        url: "/api/auth/organization/create",
        payload: { name: "Plugin bypass" },
        headers: { origin, cookie: ownerCookie ?? "" },
      });
      expect(rawOrganizationEndpoint.statusCode).toBe(404);
      for (const method of ["GET", "POST"] as const) {
        for (const cookie of [undefined, ownerCookie]) {
          const blockedOrganizationReadOrWrite = await app.inject({
            method,
            url: "/api/auth/organization/list-invitations/",
            ...(method === "POST" ? { payload: { organizationId: firstBusiness.id } } : {}),
            headers: {
              origin,
              ...(cookie ? { cookie } : {}),
            },
          });
          expect(blockedOrganizationReadOrWrite.statusCode).toBe(404);
        }
      }

      const secondUserCookie = await register("+2348041234567");
      const secondUserSession = await app.inject({
        method: "GET",
        url: "/api/auth/get-session",
        headers: { cookie: secondUserCookie ?? "" },
      });
      const secondUserId = secondUserSession.json<{ user: { id: string } }>().user.id;
      const crossBusinessSwitch = await app.inject({
        method: "PUT",
        url: "/api/businesses/active",
        payload: { organizationId: firstBusiness.id },
        headers: { origin, cookie: secondUserCookie ?? "" },
      });
      expect(crossBusinessSwitch.statusCode).toBe(403);
      const appAuth = createTestAuth();
      await appAuth.api.addMember({
        body: { userId: secondUserId, organizationId: firstBusiness.id, role: "staff" as never },
      });
      const memberSwitch = await app.inject({
        method: "PUT",
        url: "/api/businesses/active",
        payload: { organizationId: firstBusiness.id },
        headers: { origin, cookie: secondUserCookie ?? "" },
      });
      expect(memberSwitch.statusCode).toBe(200);
      await client`DELETE FROM "member" WHERE "organization_id" = ${firstBusiness.id} AND "user_id" = ${secondUserId}`;
      const revokedActive = await app.inject({
        method: "GET",
        url: "/api/businesses/active",
        headers: { cookie: secondUserCookie ?? "" },
      });
      expect(revokedActive.json<{ business: unknown }>().business).toBeNull();
      const deniedSwitch = await app.inject({
        method: "PUT",
        url: "/api/businesses/active",
        payload: { organizationId: firstBusiness.id },
        headers: { origin, cookie: secondUserCookie ?? "" },
      });
      expect(deniedSwitch.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("routes business create, list, and switch through the production Next.js proxy", async () => {
    const origin = "http://127.0.0.1:3000";
    const environment = {
      AUTH_ENABLED: "true",
      DATABASE_URL: databaseUrl as string,
      BETTER_AUTH_SECRET: "integration-test-secret-with-at-least-32-chars",
      BETTER_AUTH_URL: "https://auth.mizvo.test",
      BETTER_AUTH_TRUSTED_ORIGINS: `${origin},https://app.mizvo.test`,
      NODE_ENV: "production",
    };
    const app = buildApp(environment, { smsTransport });
    const webDirectory = resolve(process.cwd(), "../web");
    const nextCli = resolve(webDirectory, "node_modules/next/dist/bin/next");
    let nextOutput = "";
    let nextServer: ReturnType<typeof spawn> | undefined;

    try {
      await app.listen({ host: "127.0.0.1", port: 4000 });
      nextServer = spawn(
        process.execPath,
        [nextCli, "start", "--hostname", "127.0.0.1", "--port", "3000"],
        {
          cwd: webDirectory,
          env: {
            ...process.env,
            MIZVO_API_ORIGIN: "http://127.0.0.1:4000",
            NEXT_TELEMETRY_DISABLED: "1",
          },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      nextServer.stderr?.setEncoding("utf8");
      nextServer.stderr?.on("data", (chunk: string) => {
        nextOutput += chunk;
      });

      let nextReady = false;
      for (let attempt = 0; attempt < 120 && !nextReady; attempt += 1) {
        if (nextServer.exitCode !== null || nextServer.signalCode !== null) {
          throw new Error(`Next.js exited before startup: ${nextOutput}`);
        }
        try {
          const response = await fetch(origin);
          nextReady = response.ok;
        } catch {
          nextReady = false;
        }
        if (!nextReady) await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      }
      if (!nextReady) throw new Error(`Next.js did not become ready: ${nextOutput}`);

      const sendOtp = await fetch(`${origin}/api/auth/phone-number/send-otp`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ phoneNumber: "+2348031234567" }),
      });
      expect(sendOtp.status).toBe(200);
      const verifyOtp = await fetch(`${origin}/api/auth/phone-number/verify`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ phoneNumber: "+2348031234567", code: deliveries.at(-1)?.code }),
      });
      expect(verifyOtp.status).toBe(200);
      const cookie = verifyOtp.headers
        .getSetCookie()
        .map((value) => value.split(";", 1)[0])
        .join("; ");
      expect(cookie).toContain("better-auth");

      const createBusiness = (name: string) =>
        fetch(`${origin}/api/businesses`, {
          method: "POST",
          headers: { origin, cookie, "content-type": "application/json" },
          body: JSON.stringify({ name }),
        });
      const firstResponse = await createBusiness("Proxy Shop One");
      expect(firstResponse.status).toBe(201);
      const firstBusiness = (await firstResponse.json()).business as { id: string };
      const secondResponse = await createBusiness("Proxy Shop Two");
      expect(secondResponse.status).toBe(201);
      const secondBusiness = (await secondResponse.json()).business as { id: string };

      const listResponse = await fetch(`${origin}/api/businesses`, { headers: { cookie } });
      expect(listResponse.status).toBe(200);
      expect((await listResponse.json()).businesses).toHaveLength(2);

      const switchResponse = await fetch(`${origin}/api/businesses/active`, {
        method: "PUT",
        headers: { origin, cookie, "content-type": "application/json" },
        body: JSON.stringify({ organizationId: firstBusiness.id }),
      });
      expect(switchResponse.status).toBe(200);
      const activeResponse = await fetch(`${origin}/api/businesses/active`, {
        headers: { cookie },
      });
      expect(activeResponse.status).toBe(200);
      expect((await activeResponse.json()).business).toMatchObject({ id: firstBusiness.id });
      expect(secondBusiness.id).not.toBe(firstBusiness.id);
    } finally {
      if (nextServer && nextServer.exitCode === null && nextServer.signalCode === null) {
        nextServer.kill("SIGTERM");
        await Promise.race([
          new Promise<void>((resolveExit) => nextServer?.once("exit", () => resolveExit())),
          new Promise((resolveDelay) => setTimeout(resolveDelay, 5000)),
        ]);
      }
      await app.close();
    }
  }, 30_000);
});
