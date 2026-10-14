import { createRequire } from "node:module";
import { isValidPhoneNumber, parsePhoneNumber } from "libphonenumber-js/max";

export type SmsDeliveryResult = { status: "accepted" };

export interface SmsTransport {
  sendVerificationCode(phoneNumber: string, code: string): Promise<SmsDeliveryResult>;
}

export class SmsDeliveryError extends Error {
  constructor(
    readonly category:
      | "unconfigured"
      | "sender-approval"
      | "account-funding"
      | "risk-hold"
      | "invalid-recipient"
      | "provider-rejected"
      | "unavailable",
  ) {
    super("Verification message could not be sent");
    this.name = "SmsDeliveryError";
  }
}

export function normalizeNigerianPhoneNumber(input: string): string | null {
  const trimmed = input.trim();
  const candidate = trimmed.startsWith("+")
    ? trimmed
    : trimmed.startsWith("0")
      ? `+234${trimmed.slice(1)}`
      : trimmed.startsWith("234")
        ? `+${trimmed}`
        : null;
  if (!candidate || !isValidPhoneNumber(candidate, "NG")) return null;
  const parsed = parsePhoneNumber(candidate, "NG");
  return parsed.country === "NG" && parsed.isValid() && parsed.getType() === "MOBILE"
    ? parsed.number
    : null;
}

type AfricaTalkingRecipient = { statusCode?: number; status?: string };
type AfricaTalkingResponse = {
  SMSMessageData?: { Recipients?: AfricaTalkingRecipient[] };
};
type AfricaTalkingClient = {
  SMS: {
    send(options: {
      to: string[];
      senderId?: string;
      message: string;
      enqueue: false;
    }): Promise<AfricaTalkingResponse>;
  };
};

const require = createRequire(import.meta.url);

// The SDK is optional: do not load it until the Africa's Talking transport
// is actually used. Disabled OTP delivery must work without this package.
function loadAfricaTalking(options: { username: string; apiKey: string }): AfricaTalkingClient {
  const factory = require("africastalking") as (configuration: {
    username: string;
    apiKey: string;
  }) => AfricaTalkingClient;
  return factory(options);
}

export function createAfricaTalkingSmsTransport(
  env: NodeJS.ProcessEnv = process.env,
  clientFactory: typeof loadAfricaTalking = loadAfricaTalking,
): SmsTransport {
  return {
    async sendVerificationCode(phoneNumber, code) {
      const username = env.AT_USERNAME?.trim();
      const apiKey = env.AT_API_KEY?.trim();
      const senderId = env.AT_SENDER_ID?.trim();
      const sandbox = env.AT_ENVIRONMENT === "sandbox";
      if (
        !username ||
        !apiKey ||
        (!senderId && !sandbox) ||
        (sandbox && username.toLowerCase() !== "sandbox")
      ) {
        throw new SmsDeliveryError("unconfigured");
      }
      if (normalizeNigerianPhoneNumber(phoneNumber) !== phoneNumber)
        throw new SmsDeliveryError("invalid-recipient");

      let response: AfricaTalkingResponse;
      try {
        response = await clientFactory({ username, apiKey }).SMS.send({
          to: [phoneNumber],
          ...(senderId ? { senderId } : {}),
          message: `Your Mizvo verification code is ${code}. It expires in 5 minutes. Do not share it.`,
          enqueue: false,
        });
      } catch {
        throw new SmsDeliveryError("unavailable");
      }

      const recipients = response.SMSMessageData?.Recipients;
      const providerStatus = recipients?.length === 1 ? recipients[0]?.statusCode : undefined;
      if (providerStatus === undefined || ![100, 101, 102].includes(providerStatus)) {
        const failureCategory =
          providerStatus === 401
            ? "risk-hold"
            : providerStatus === 402
              ? "sender-approval"
              : providerStatus === 403
                ? "invalid-recipient"
                : providerStatus === 405
                  ? "account-funding"
                  : "provider-rejected";
        throw new SmsDeliveryError(failureCategory);
      }

      // The provider's 100/101/102 response means accepted/processing/queued,
      // not handset delivery. Delivery reports are not configured in Phase B.
      return { status: "accepted" };
    },
  };
}
