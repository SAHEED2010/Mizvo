import { randomUUID } from "node:crypto";
import { organization, phoneNumber } from "better-auth/plugins";
import { businessAccess, businessRoles } from "./permissions.js";

const allowedBusinessRoles = new Set(["owner", "manager", "staff", "viewer"]);

function assertBusinessRole(role: string | string[]) {
  if (Array.isArray(role) || !allowedBusinessRoles.has(role)) {
    throw new Error("A single valid Mizvo business role is required");
  }
}

export function createAuthPlugins() {
  return [
    phoneNumber({
      expiresIn: 300,
      allowedAttempts: 3,
      requireVerification: true,
      signUpOnVerification: {
        getTempEmail: () => `phone-${randomUUID()}@users.invalid`,
        getTempName: () => "Mizvo user",
      },
      async sendOTP() {
        throw new Error("Phone verification delivery is not configured");
      },
    }),
    organization({
      ac: businessAccess,
      roles: businessRoles,
      creatorRole: "owner",
      // Organization's built-in member role is not part of Mizvo's role model.
      // Replacing the base role field removes Better Auth's `member` default;
      // callers must supply one of our four roles and creatorRole remains owner.
      schema: {
        member: {
          additionalFields: {
            role: { type: "string", required: true, input: true },
          },
        },
      },
      allowUserToCreateOrganization: false,
      invitationExpiresIn: 48 * 60 * 60,
      organizationHooks: {
        async beforeAddMember({ member }) {
          assertBusinessRole(member.role);
        },
        async beforeCreateInvitation({ invitation }) {
          assertBusinessRole(invitation.role);
        },
      },
    }),
  ] as const;
}
