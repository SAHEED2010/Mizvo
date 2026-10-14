import { createHash } from "node:crypto";
import { runWithTransaction } from "@better-auth/core/context";
import type { createDatabase } from "@mizvo/database";
import { member, organization } from "@mizvo/database/schema/auth";
import { fromNodeHeaders } from "better-auth/node";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { createAuth } from "./auth/auth.js";
import { AuthorizationError, loadBusinessAccessContext } from "./auth/authorization.js";
import { isBusinessRole } from "./auth/permissions.js";

type Database = ReturnType<typeof createDatabase>;
type Auth = ReturnType<typeof createAuth>;

function headersFor(request: FastifyRequest): Headers {
  const headers = fromNodeHeaders(request.headers);
  headers.set("x-mizvo-client-ip", request.ip);
  return headers;
}

function readBusinessName(body: unknown): string | null {
  if (!body || typeof body !== "object" || !("name" in body) || typeof body.name !== "string")
    return null;
  const name = body.name.trim();
  return name.length > 0 && name.length <= 120 ? name : null;
}

function readOrganizationId(body: unknown): string | null {
  if (
    !body ||
    typeof body !== "object" ||
    !("organizationId" in body) ||
    typeof body.organizationId !== "string"
  ) {
    return null;
  }
  const organizationId = body.organizationId.trim();
  return organizationId.length > 0 && organizationId.length <= 128 ? organizationId : null;
}

function organizationSlug(name: string, userId: string): string {
  const nameSlug =
    name
      .normalize("NFKD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64) || "business";
  const accountScope = createHash("sha256").update(userId).digest("hex").slice(0, 12);
  return `${nameSlug}-${accountScope}`;
}

function hasPostgresCode(error: unknown, code: string): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    if ("code" in current && current.code === code) return true;
    current = "cause" in current ? current.cause : null;
  }
  return false;
}

async function getAuthenticatedSession(auth: Auth, request: FastifyRequest) {
  return auth.api.getSession({ headers: headersFor(request) });
}

function isTrustedOrigin(request: FastifyRequest, trustedOrigins: ReadonlySet<string>): boolean {
  const origin = request.headers.origin;
  return typeof origin === "string" && trustedOrigins.has(origin);
}

export function registerBusinessRoutes(
  app: FastifyInstance,
  auth: Auth,
  database: Database,
  trustedOrigins: ReadonlySet<string>,
): void {
  app.addHook("preHandler", async (request, reply) => {
    if (
      request.url.split("?", 1)[0]?.startsWith("/api/businesses/") &&
      request.method !== "GET" &&
      !isTrustedOrigin(request, trustedOrigins)
    ) {
      return reply.status(403).send({ message: "Origin is not allowed" });
    }
    if (
      request.url.split("?", 1)[0] === "/api/businesses" &&
      request.method === "POST" &&
      !isTrustedOrigin(request, trustedOrigins)
    ) {
      return reply.status(403).send({ message: "Origin is not allowed" });
    }
  });

  app.get("/api/businesses", async (request, reply) => {
    const session = await getAuthenticatedSession(auth, request);
    if (!session) return reply.status(401).send({ error: "authentication_required" });

    const rows = await database.db
      .select({
        id: organization.id,
        name: organization.name,
        role: member.role,
      })
      .from(member)
      .innerJoin(organization, eq(member.organizationId, organization.id))
      .where(eq(member.userId, session.user.id));
    const businesses = rows.filter((row) => isBusinessRole(row.role));
    const activeBusinessId = businesses.some(
      (business) => business.id === session.session.activeOrganizationId,
    )
      ? (session.session.activeOrganizationId ?? null)
      : null;

    if (session.session.activeOrganizationId && !activeBusinessId) {
      await auth.api.setActiveOrganization({
        headers: headersFor(request),
        body: { organizationId: null },
      });
    }

    return reply.send({ businesses, activeBusinessId });
  });

  app.get("/api/businesses/active", async (request, reply) => {
    const session = await getAuthenticatedSession(auth, request);
    if (!session) return reply.status(401).send({ error: "authentication_required" });
    const organizationId = session.session.activeOrganizationId;
    if (!organizationId) return reply.send({ business: null });

    let context: Awaited<ReturnType<typeof loadBusinessAccessContext>>;
    try {
      context = await loadBusinessAccessContext(database.db, session.user.id, organizationId);
    } catch (error) {
      if (!(error instanceof AuthorizationError)) throw error;
      await auth.api.setActiveOrganization({
        headers: headersFor(request),
        body: { organizationId: null },
      });
      return reply.send({ business: null });
    }
    const [business] = await database.db
      .select({ id: organization.id, name: organization.name })
      .from(organization)
      .where(eq(organization.id, context.organizationId))
      .limit(1);
    if (!business) return reply.send({ business: null });
    return reply.send({ business: { ...business, role: context.role } });
  });

  app.post("/api/businesses", async (request, reply) => {
    const session = await getAuthenticatedSession(auth, request);
    if (!session) return reply.status(401).send({ error: "authentication_required" });
    if (session.user.phoneNumberVerified !== true) {
      return reply.status(403).send({ error: "verified_phone_required" });
    }

    const name = readBusinessName(request.body);
    if (!name) return reply.status(400).send({ error: "invalid_business_name" });

    try {
      const context = await auth.$context;
      const created = await runWithTransaction(context.adapter, async () => {
        const organizationResult = await auth.api.createOrganization({
          headers: headersFor(request),
          body: { name, slug: organizationSlug(name, session.user.id) },
        });
        const createdMembers = organizationResult.members ?? [];
        const owners = createdMembers.filter(
          (candidate) => candidate?.userId === session.user.id && candidate.role === "owner",
        );
        if (createdMembers.length !== 1 || owners.length !== 1) {
          throw new Error("Business owner bootstrap invariant failed");
        }
        return organizationResult;
      });
      await auth.api.setActiveOrganization({
        headers: headersFor(request),
        body: { organizationId: created.id },
      });
      return reply.status(201).send({
        business: {
          id: created.id,
          name: created.name,
          role: "owner",
        },
        activeBusinessId: created.id,
      });
    } catch (error) {
      if (hasPostgresCode(error, "23505")) {
        return reply.status(409).send({ error: "business_already_exists" });
      }
      throw error;
    }
  });

  app.put("/api/businesses/active", async (request, reply) => {
    const session = await getAuthenticatedSession(auth, request);
    if (!session) return reply.status(401).send({ error: "authentication_required" });

    const organizationId = readOrganizationId(request.body);
    if (!organizationId) return reply.status(400).send({ error: "invalid_business_selection" });

    try {
      const context = await loadBusinessAccessContext(database.db, session.user.id, organizationId);
      const [business] = await database.db
        .select({ id: organization.id, name: organization.name })
        .from(organization)
        .where(eq(organization.id, organizationId))
        .limit(1);
      if (!business) return reply.status(404).send({ error: "business_not_found" });

      await auth.api.setActiveOrganization({
        headers: headersFor(request),
        body: { organizationId },
      });
      return reply.send({
        activeBusinessId: organizationId,
        business: { ...business, role: context.role },
      });
    } catch (error) {
      if (error instanceof AuthorizationError) {
        return reply.status(403).send({ error: "business_access_denied" });
      }
      throw error;
    }
  });
}
