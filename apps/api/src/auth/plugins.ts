import { randomUUID } from "node:crypto";
import { organization, phoneNumber } from "better-auth/plugins";
import { businessAccess, businessRoles } from "./permissions.js";

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
      allowUserToCreateOrganization: false,
      invitationExpiresIn: 48 * 60 * 60,
    }),
  ] as const;
}
