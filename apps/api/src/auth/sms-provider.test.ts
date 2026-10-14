import { describe, expect, it, vi } from "vitest";
import type { SmsTransport } from "./sms.js";
import { SmsDeliveryError } from "./sms.js";
import { createOtpSmsTransport } from "./sms-provider.js";

describe("OTP SMS provider selection", () => {
  it("defaults to disabled and fails closed", async () => {
    const africaTalking = vi.fn();
    const transport = createOtpSmsTransport({}, { africaTalking });

    await expect(transport.sendVerificationCode("+2348031234567", "104928")).rejects.toMatchObject({
      category: "unconfigured",
    });
    expect(africaTalking).not.toHaveBeenCalled();
  });

  it("selects Africa's Talking only when explicitly configured", async () => {
    const selected: SmsTransport = {
      async sendVerificationCode() {
        return { status: "accepted" };
      },
    };
    const africaTalking = vi.fn(() => selected);
    const env = { OTP_DELIVERY_PROVIDER: "africastalking" };

    expect(createOtpSmsTransport(env, { africaTalking })).toBe(selected);
    expect(africaTalking).toHaveBeenCalledWith(env);
  });

  it("rejects unknown provider values rather than silently falling back", () => {
    expect(() => createOtpSmsTransport({ OTP_DELIVERY_PROVIDER: "other-sms" })).toThrow(
      "OTP_DELIVERY_PROVIDER must be disabled or africastalking",
    );
  });

  it("preserves provider-neutral delivery failures", async () => {
    const selected: SmsTransport = {
      async sendVerificationCode() {
        throw new SmsDeliveryError("unavailable");
      },
    };
    const transport = createOtpSmsTransport(
      { OTP_DELIVERY_PROVIDER: "africastalking" },
      { africaTalking: () => selected },
    );

    await expect(transport.sendVerificationCode("+2348031234567", "104928")).rejects.toMatchObject({
      category: "unavailable",
      message: "Verification message could not be sent",
    });
  });
});
