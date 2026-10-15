import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { getCurrentAdapter, runWithTransaction } from "@better-auth/core/context";
import type { createAuth } from "./auth.js";
import { normalizeNigerianPhoneNumber } from "./sms.js";

export const phoneInvitationRoles = ["manager", "staff", "viewer"] as const;
export type PhoneInvitationRole = (typeof phoneInvitationRoles)[number];

export class PhoneInvitationError extends Error {
  constructor(readonly code: "forbidden" | "invalid_invitation" | "already_member") {
    super(code);
    this.name = "PhoneInvitationError";
  }
}

type Auth = ReturnType<typeof createAuth>;

function isInvitationRole(role: string): role is PhoneInvitationRole {
  return phoneInvitationRoles.includes(role as PhoneInvitationRole);
}

function recipientHash(phoneNumber: string, secret: string): string {
  return createHmac("sha256", secret)
    .update("mizvo:phone-invitation-recipient:v1:")
    .update(phoneNumber)
    .digest("hex");
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function withAdapterTransaction<T>(auth: Auth, operation: () => Promise<T>): Promise<T> {
  const context = await auth.$context;
  return runWithTransaction(context.adapter, operation);
}

async function assertOwner(auth: Auth, organizationId: string, userId: string): Promise<void> {
  const context = await auth.$context;
  const adapter = await getCurrentAdapter(context.adapter);
  const owner = await adapter.findOne<{ id: string }>({
    model: "member",
    where: [
      { field: "organizationId", value: organizationId },
      { field: "userId", value: userId },
      { field: "role", value: "owner" },
    ],
    select: ["id"],
  });
  if (!owner) throw new PhoneInvitationError("forbidden");
}

async function writeAuditEvent(
  auth: Auth,
  event: {
    organizationId: string;
    actorId: string;
    action: "invitation.created" | "invitation.revoked" | "invitation.accepted";
    invitationId: string;
    subjectUserId?: string;
    role?: PhoneInvitationRole;
    createdAt: Date;
  },
): Promise<void> {
  const context = await auth.$context;
  const adapter = await getCurrentAdapter(context.adapter);
  await adapter.create({
    model: "businessAuditEvent",
    forceAllowId: true,
    data: { id: randomUUID(), ...event },
  });
}

/**
 * Internal C2 lifecycle operation. It is not called by an HTTP handler while
 * the C3 owner-security gate remains unavailable.
 */
export async function createPhoneInvitation(
  auth: Auth,
  input: {
    organizationId: string;
    inviterId: string;
    recipientPhoneNumber: string;
    role: string;
    phoneHashSecret: string;
  },
): Promise<{ invitationId: string; token: string; expiresAt: Date }> {
  const normalizedPhone = normalizeNigerianPhoneNumber(input.recipientPhoneNumber);
  const role = input.role;
  if (
    !normalizedPhone ||
    normalizedPhone !== input.recipientPhoneNumber ||
    !isInvitationRole(role) ||
    input.phoneHashSecret.length < 32
  ) {
    throw new PhoneInvitationError("invalid_invitation");
  }

  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const invitationId = randomUUID();
  const context = await auth.$context;

  await withAdapterTransaction(auth, async () => {
    await assertOwner(auth, input.organizationId, input.inviterId);
    const adapter = await getCurrentAdapter(context.adapter);
    await adapter.create({
      model: "phoneInvitation",
      forceAllowId: true,
      data: {
        id: invitationId,
        organizationId: input.organizationId,
        recipientPhoneHash: recipientHash(normalizedPhone, input.phoneHashSecret),
        tokenHash: tokenHash(token),
        role,
        status: "pending",
        expiresAt,
        createdAt: now,
        inviterId: input.inviterId,
        acceptedBy: null,
        acceptedAt: null,
        revokedBy: null,
        revokedAt: null,
      },
    });
    await writeAuditEvent(auth, {
      organizationId: input.organizationId,
      actorId: input.inviterId,
      action: "invitation.created",
      invitationId,
      role,
      createdAt: now,
    });
  });

  return { invitationId, token, expiresAt };
}

/** Internal, tenant-scoped revocation; no API route currently invokes it. */
export async function revokePhoneInvitation(
  auth: Auth,
  input: { organizationId: string; inviterId: string; invitationId: string },
): Promise<void> {
  const now = new Date();
  const context = await auth.$context;

  await withAdapterTransaction(auth, async () => {
    await assertOwner(auth, input.organizationId, input.inviterId);
    const adapter = await getCurrentAdapter(context.adapter);
    const invitation = await adapter.findOne<{ id: string; role: string }>({
      model: "phoneInvitation",
      where: [
        { field: "id", value: input.invitationId },
        { field: "organizationId", value: input.organizationId },
        { field: "status", value: "pending" },
      ],
      select: ["id", "role"],
    });
    if (!invitation || !isInvitationRole(invitation.role)) {
      throw new PhoneInvitationError("invalid_invitation");
    }
    const changed = await adapter.updateMany({
      model: "phoneInvitation",
      where: [
        { field: "id", value: invitation.id },
        { field: "organizationId", value: input.organizationId },
        { field: "status", value: "pending" },
      ],
      update: { status: "revoked", revokedBy: input.inviterId, revokedAt: now },
    });
    if (changed !== 1) throw new PhoneInvitationError("invalid_invitation");
    await writeAuditEvent(auth, {
      organizationId: input.organizationId,
      actorId: input.inviterId,
      action: "invitation.revoked",
      invitationId: invitation.id,
      role: invitation.role,
      createdAt: now,
    });
  });
}

/**
 * Internal recipient acceptance. The caller must pass the authenticated user
 * ID from Better Auth; phone verification is re-read from the database.
 */
export async function acceptPhoneInvitation(
  auth: Auth,
  input: { token: string; recipientUserId: string; phoneHashSecret: string },
): Promise<{ organizationId: string; role: PhoneInvitationRole }> {
  if (input.token.length !== 43 || input.phoneHashSecret.length < 32) {
    throw new PhoneInvitationError("invalid_invitation");
  }
  const now = new Date();
  const context = await auth.$context;
  let result: { organizationId: string; role: PhoneInvitationRole } | undefined;

  await withAdapterTransaction(auth, async () => {
    const adapter = await getCurrentAdapter(context.adapter);
    const [invitation, recipient] = await Promise.all([
      adapter.findOne<{
        id: string;
        organizationId: string;
        recipientPhoneHash: string;
        role: string;
        status: string;
        expiresAt: Date;
      }>({
        model: "phoneInvitation",
        where: [{ field: "tokenHash", value: tokenHash(input.token) }],
        select: ["id", "organizationId", "recipientPhoneHash", "role", "status", "expiresAt"],
      }),
      adapter.findOne<{ id: string; phoneNumber: string | null; phoneNumberVerified: boolean }>({
        model: "user",
        where: [{ field: "id", value: input.recipientUserId }],
        select: ["id", "phoneNumber", "phoneNumberVerified"],
      }),
    ]);

    if (
      !invitation ||
      !recipient ||
      !isInvitationRole(invitation.role) ||
      invitation.status !== "pending" ||
      invitation.expiresAt.getTime() <= now.getTime() ||
      recipient.phoneNumberVerified !== true ||
      !recipient.phoneNumber ||
      normalizeNigerianPhoneNumber(recipient.phoneNumber) !== recipient.phoneNumber
    ) {
      throw new PhoneInvitationError("invalid_invitation");
    }

    const expectedRecipientHash = Buffer.from(
      recipientHash(recipient.phoneNumber, input.phoneHashSecret),
      "hex",
    );
    const storedRecipientHash = Buffer.from(invitation.recipientPhoneHash, "hex");
    if (
      expectedRecipientHash.length !== storedRecipientHash.length ||
      !timingSafeEqual(expectedRecipientHash, storedRecipientHash)
    ) {
      throw new PhoneInvitationError("invalid_invitation");
    }

    const existingMembership = await adapter.findOne<{ id: string }>({
      model: "member",
      where: [
        { field: "organizationId", value: invitation.organizationId },
        { field: "userId", value: input.recipientUserId },
      ],
      select: ["id"],
    });
    if (existingMembership) throw new PhoneInvitationError("already_member");

    const claimed = await adapter.updateMany({
      model: "phoneInvitation",
      where: [
        { field: "id", value: invitation.id },
        { field: "status", value: "pending" },
        { field: "expiresAt", operator: "gt", value: now },
      ],
      update: { status: "accepted", acceptedBy: input.recipientUserId, acceptedAt: now },
    });
    if (claimed !== 1) throw new PhoneInvitationError("invalid_invitation");

    // The Organization plugin's server-only API remains the only membership
    // writer; this call participates in the surrounding Better Auth transaction.
    await auth.api.addMember({
      body: {
        organizationId: invitation.organizationId,
        userId: input.recipientUserId,
        role: invitation.role,
      },
    });
    await writeAuditEvent(auth, {
      organizationId: invitation.organizationId,
      actorId: input.recipientUserId,
      action: "invitation.accepted",
      invitationId: invitation.id,
      subjectUserId: input.recipientUserId,
      role: invitation.role,
      createdAt: now,
    });
    result = { organizationId: invitation.organizationId, role: invitation.role };
  });

  if (!result) throw new PhoneInvitationError("invalid_invitation");
  return result;
}
