import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("API bootstrap", () => {
  it("serves the public health status", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("does not expose authentication routes before delivery is configured", async () => {
    const app = buildApp({ AUTH_ENABLED: "false" });
    const response = await app.inject({ method: "POST", url: "/api/auth/phone-number/send-otp" });

    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
