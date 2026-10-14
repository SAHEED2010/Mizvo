import type { createDatabase } from "@mizvo/database";
import { member } from "@mizvo/database/schema/auth";
import { and, eq } from "drizzle-orm";
import type { createAuth } from "./auth.js";
import {
  type BusinessPermission,
  type BusinessRole,
  businessPermissions,
  isBusinessRole,
} from "./permissions.js";

export interface OrganizationMembership {
  organizationId: string;
  userId: string;
  role: string;
}

export interface BusinessAccessContext {
  organizationId: string;
  userId: string;
  role: BusinessRole;
}

type Database = ReturnType<typeof createDatabase>["db"];

export class AuthorizationError extends Error {
  constructor(message = "Access denied") {
    super(message);
    this.name = "AuthorizationError";
  }
}

export class AuthenticationError extends Error {
  constructor() {
    super("Authentication required");
    this.name = "AuthenticationError";
  }
}

export async function requireAuthenticatedUser(
  auth: ReturnType<typeof createAuth>,
  headers: Headers,
): Promise<string> {
  const session = await auth.api.getSession({ headers });
  if (!session) throw new AuthenticationError();
  return session.user.id;
}

export async function requireAuthenticatedBusinessContext(
  auth: ReturnType<typeof createAuth>,
  db: Database,
  headers: Headers,
  requestedOrganizationId: string,
): Promise<BusinessAccessContext> {
  const userId = await requireAuthenticatedUser(auth, headers);
  return loadBusinessAccessContext(db, userId, requestedOrganizationId);
}

export function requireBusinessMembership(
  membership: OrganizationMembership | null,
  userId: string,
  requestedOrganizationId: string,
): BusinessAccessContext {
  if (
    !membership ||
    membership.userId !== userId ||
    membership.organizationId !== requestedOrganizationId ||
    !isBusinessRole(membership.role)
  ) {
    throw new AuthorizationError();
  }

  return {
    organizationId: membership.organizationId,
    userId: membership.userId,
    role: membership.role as BusinessRole,
  };
}

export async function loadBusinessAccessContext(
  db: Database,
  userId: string,
  requestedOrganizationId: string,
): Promise<BusinessAccessContext> {
  const [membership] = await db
    .select({ organizationId: member.organizationId, userId: member.userId, role: member.role })
    .from(member)
    .where(and(eq(member.userId, userId), eq(member.organizationId, requestedOrganizationId)))
    .limit(1);
  return requireBusinessMembership(membership ?? null, userId, requestedOrganizationId);
}

export function requireBusinessPermission(
  context: BusinessAccessContext,
  permission: BusinessPermission,
): void {
  if (!(businessPermissions[context.role] as readonly BusinessPermission[]).includes(permission)) {
    throw new AuthorizationError();
  }
}

export function assertOwnerRemains(
  memberships: readonly OrganizationMembership[],
  organizationId: string,
  memberId: string,
  nextRole: string | null,
): void {
  const member = memberships.find(
    (candidate) => candidate.userId === memberId && candidate.organizationId === organizationId,
  );
  if (!member || member.role !== "owner") return;
  if (nextRole === "owner") return;

  const anotherOwnerRemains = memberships.some(
    (candidate) =>
      candidate.userId !== memberId &&
      candidate.organizationId === organizationId &&
      candidate.role === "owner",
  );
  if (!anotherOwnerRemains)
    throw new AuthorizationError("A business must retain at least one owner");
}
