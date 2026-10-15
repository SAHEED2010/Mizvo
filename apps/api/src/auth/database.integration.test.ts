import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createDatabase } from "@mizvo/database";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createAuth } from "./auth.js";
import { createPostgresOtpRateLimiter } from "./otp-rate-limit.js";
import {
  acceptPhoneInvitation,
  createPhoneInvitation,
  revokePhoneInvitation,
} from "./phone-invitations.js";
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
    await client`TRUNCATE TABLE "business_audit_event", "phone_invitation", "invitation", "member", "organization", "session", "account", "verification", "rate_limit", "user" CASCADE`;
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
  });
});
