import { resolve } from "node:path";
import { createDatabase } from "@mizvo/database";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createAuth } from "./auth.js";
import { createPostgresOtpRateLimiter } from "./otp-rate-limit.js";
import type { SmsTransport } from "./sms.js";

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
    if (
      !["localhost", "127.0.0.1", "::1"].includes(target.hostname) ||
      target.pathname !== "/mizvo_test"
    ) {
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
    await client`TRUNCATE TABLE "invitation", "member", "organization", "session", "account", "verification", "rate_limit", "user" CASCADE`;
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
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    const signedOut = await app.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      payload: {},
      headers: { origin: "https://app.mizvo.test", cookie: cookieHeader ?? "" },
    });
    expect(signedOut.statusCode).toBe(200);
    await app.close();
  });
});
