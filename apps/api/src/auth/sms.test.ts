import { describe, expect, it, vi } from "vitest";
import type { SmsTransport } from "./sms.js";
import {
  createAfricaTalkingSmsTransport,
  normalizeNigerianPhoneNumber,
  SmsDeliveryError,
} from "./sms.js";

class FakeSmsTransport implements SmsTransport {
  readonly sent: Array<{ phoneNumber: string; code: string }> = [];
  failWith: SmsDeliveryError | null = null;

  async sendVerificationCode(phoneNumber: string, code: string) {
    if (this.failWith) throw this.failWith;
    this.sent.push({ phoneNumber, code });
    return { status: "accepted" as const };
  }
}

describe("Nigerian phone normalization", () => {
  it.each([
    ["0803 123 4567", "+2348031234567"],
    ["2348031234567", "+2348031234567"],
    ["+2348031234567", "+2348031234567"],
  ])("normalizes %s to E.164", (input, expected) => {
    expect(normalizeNigerianPhoneNumber(input)).toBe(expected);
  });

  it.each([
    "0803123",
    "+14155552671",
    "+2341123456789",
    "not a number",
  ])("rejects unsupported input %s", (input) =>
    expect(normalizeNigerianPhoneNumber(input)).toBeNull());
});

describe("Africa's Talking SMS transport", () => {
  const configuration = {
    AT_ENVIRONMENT: "production",
    AT_USERNAME: "mizvo-test",
    AT_API_KEY: "test-key",
    AT_SENDER_ID: "MIZVO",
  };

  it("uses the configured adapter, submits one Nigerian OTP and reports accepted only", async () => {
    const send = vi.fn().mockResolvedValue({
      SMSMessageData: { Recipients: [{ statusCode: 102, status: "Queued" }] },
    });
    const transport = createAfricaTalkingSmsTransport(configuration, () => ({ SMS: { send } }));

    await expect(transport.sendVerificationCode("+2348031234567", "104928")).resolves.toEqual({
      status: "accepted",
    });
    expect(send).toHaveBeenCalledWith({
      to: ["+2348031234567"],
      senderId: "MIZVO",
      message: "Your Mizvo verification code is 104928. It expires in 5 minutes. Do not share it.",
      enqueue: false,
    });
  });

  it("fails closed when credentials or an approved production sender are missing", async () => {
    const factory = vi.fn();
    const transport = createAfricaTalkingSmsTransport({}, factory as never);

    await expect(transport.sendVerificationCode("+2348031234567", "104928")).rejects.toMatchObject({
      category: "unconfigured",
    });
    expect(factory).not.toHaveBeenCalled();
  });

  it.each([
    [401, "risk-hold"],
    [402, "sender-approval"],
    [403, "invalid-recipient"],
    [404, "provider-rejected"],
    [405, "account-funding"],
    [406, "provider-rejected"],
    [undefined, "provider-rejected"],
  ] as const)("safely classifies provider status %s", async (statusCode, category) => {
    const send = vi.fn().mockResolvedValue({
      SMSMessageData: {
        Recipients: statusCode
          ? [{ statusCode, status: "Do not include vendor response text" }]
          : [],
      },
    });
    const transport = createAfricaTalkingSmsTransport(configuration, () => ({ SMS: { send } }));
    const error = await transport
      .sendVerificationCode("+2348031234567", "104928")
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SmsDeliveryError);
    expect((error as SmsDeliveryError).category).toBe(category);
    expect((error as Error).message).toBe("Verification message could not be sent");
  });

  it("contains rejected SDK errors and does not echo credentials or message text", async () => {
    const transport = createAfricaTalkingSmsTransport(configuration, () => ({
      SMS: { send: vi.fn().mockRejectedValue(new Error("secret key and OTP content")) },
    }));
    const error = await transport
      .sendVerificationCode("+2348031234567", "104928")
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(SmsDeliveryError);
    expect((error as Error).message).toBe("Verification message could not be sent");
  });
});

describe("test-only fake transport", () => {
  it("can be injected without adding a public OTP endpoint", async () => {
    const fake = new FakeSmsTransport();
    await fake.sendVerificationCode("+2348031234567", "104928");
    expect(fake.sent).toEqual([{ phoneNumber: "+2348031234567", code: "104928" }]);
  });

  it("can model vendor failure for callback tests", async () => {
    const fake = new FakeSmsTransport();
    fake.failWith = new SmsDeliveryError("unavailable");
    await expect(fake.sendVerificationCode("+2348031234567", "104928")).rejects.toMatchObject({
      category: "unavailable",
    });
    expect(fake.sent).toHaveLength(0);
  });
});
