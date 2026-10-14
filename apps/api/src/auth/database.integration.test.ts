import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "./auth.js";

const databaseUrl = process.env.DATABASE_URL;
const postgresSuite = databaseUrl ? describe : describe.skip;

postgresSuite("authentication PostgreSQL invariants", () => {
  let client: ReturnType<typeof postgres>;

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
    const db = drizzle(client);
    await migrate(db, {
      migrationsFolder: resolve(process.cwd(), "../../packages/database/migrations"),
    });
  });

  beforeEach(async () => {
    await client`TRUNCATE TABLE "invitation", "member", "organization", "session", "account", "verification", "user" CASCADE`;
  });

  afterAll(async () => {
    await client?.end();
  });

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
    const auth = createAuth({
      DATABASE_URL: databaseUrl,
      BETTER_AUTH_SECRET: "integration-test-secret-with-at-least-32-chars",
      BETTER_AUTH_URL: "http://127.0.0.1:4000",
    });

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
    const [{ role }] = await client`SELECT "role" FROM "member" WHERE "user_id" = ${users[2]}`;
    expect(role).toBeUndefined();
  });

  it("documents the current owner guard by rejecting organization cascade deletion", async () => {
    await seedBusiness();
    await expect(client`DELETE FROM "organization" WHERE "id" = 'org-test'`).rejects.toThrow(
      /retain at least one owner/,
    );
  });
});
