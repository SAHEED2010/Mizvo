import { randomUUID } from "node:crypto";
import { organization, phoneNumber } from "better-auth/plugins";
import { businessAccess, businessRoles } from "./permissions.js";
import type { SmsTransport } from "./sms.js";
import { normalizeNigerianPhoneNumber, SmsDeliveryError } from "./sms.js";

const allowedBusinessRoles = new Set(["owner", "manager", "staff", "viewer"]);

function assertBusinessRole(role: string | string[]) {
  if (Array.isArray(role) || !allowedBusinessRoles.has(role)) {
    throw new Error("A single valid Mizvo business role is required");
  }
}

export function createAuthPlugins(smsTransport: SmsTransport) {
  return [
    phoneNumber({
      expiresIn: 300,
      allowedAttempts: 3,
      requireVerification: true,
      phoneNumberValidator: (value) => normalizeNigerianPhoneNumber(value) === value,
      signUpOnVerification: {
        getTempEmail: () => `phone-${randomUUID()}@users.invalid`,
        getTempName: () => "Mizvo user",
      },
      async sendOTP({ phoneNumber, code }, ctx) {
        try {
          await smsTransport.sendVerificationCode(phoneNumber, code);
        } catch (error) {
          const category = error instanceof SmsDeliveryError ? error.category : "unavailable";
          ctx?.context.logger.error("Phone OTP delivery failed", { category });
          // Do not let provider errors, recipient data, or OTP content reach API responses.
          throw new SmsDeliveryError(category);
        }
      },
      async sendPasswordResetOTP() {
        throw new SmsDeliveryError("unconfigured");
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
      allowUserToCreateOrganization: async (user) => user.phoneNumberVerified === true,
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
