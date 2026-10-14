import type { SmsTransport } from "./sms.js";
import { createAfricaTalkingSmsTransport, SmsDeliveryError } from "./sms.js";

export type OtpDeliveryProvider = "disabled" | "africastalking";

export interface SmsProviderFactories {
  africaTalking?: (env: NodeJS.ProcessEnv) => SmsTransport;
}

const disabledTransport: SmsTransport = {
  async sendVerificationCode() {
    throw new SmsDeliveryError("unconfigured");
  },
};

export function createOtpSmsTransport(
  env: NodeJS.ProcessEnv = process.env,
  factories: SmsProviderFactories = {},
): SmsTransport {
  const provider = env.OTP_DELIVERY_PROVIDER?.trim() || "disabled";

  switch (provider) {
    case "disabled":
      return disabledTransport;
    case "africastalking":
      return (factories.africaTalking ?? createAfricaTalkingSmsTransport)(env);
    default:
      throw new Error("OTP_DELIVERY_PROVIDER must be disabled or africastalking");
  }
}
