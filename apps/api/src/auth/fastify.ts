import { createDatabase } from "@mizvo/database";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import postgres from "postgres";
import { createAuth } from "./auth.js";
import { createPostgresOtpRateLimiter } from "./otp-rate-limit.js";
import type { SmsTransport } from "./sms.js";

export function registerAuthRoutes(
  app: FastifyInstance,
  env: NodeJS.ProcessEnv = process.env,
  options: { smsTransport?: SmsTransport } = {},
): void {
  if (env.AUTH_ENABLED !== "true") return;

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required when AUTH_ENABLED=true");
  const database = createDatabase(databaseUrl);
  const auth = createAuth(env, { ...options, database });
  const otpRateLimiter = createPostgresOtpRateLimiter(
    postgres(databaseUrl, { max: 2, prepare: false }),
  );
  const trustedOrigins = new Set(
    (env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
      .map((origin) => {
        try {
          return new URL(origin).origin;
        } catch {
          return "";
        }
      }),
  );
  app.addHook("onClose", async () => {
    await Promise.all([otpRateLimiter.close(), database.client.end()]);
  });
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async preHandler(request: FastifyRequest, reply: FastifyReply) {
      if (request.method !== "POST") return;

      const origin = request.headers.origin;
      if (!origin || !trustedOrigins.has(origin)) {
        return reply.status(403).send({ message: "Origin is not allowed" });
      }

      const path = request.url.split("?", 1)[0];
      const operation =
        path === "/api/auth/phone-number/send-otp"
          ? "request"
          : path === "/api/auth/phone-number/verify"
            ? "verify"
            : null;
      if (!operation) return;

      const body = request.body;
      const phoneNumber =
        body &&
        typeof body === "object" &&
        "phoneNumber" in body &&
        typeof body.phoneNumber === "string"
          ? body.phoneNumber
          : null;
      const allowed = await otpRateLimiter.consume(operation, phoneNumber, request.ip);
      if (!allowed) {
        return reply
          .status(429)
          .header("retry-after", "900")
          .send({ message: "Please wait before trying again." });
      }
    },
    async handler(request: FastifyRequest, reply: FastifyReply) {
      try {
        const baseURL = env.BETTER_AUTH_URL;
        if (!baseURL) throw new Error("BETTER_AUTH_URL is required");
        const requestUrl = new URL(request.url, baseURL);
        const headers = fromNodeHeaders(request.headers);
        headers.set("x-mizvo-client-ip", request.ip);
        const authRequest = new Request(requestUrl, {
          method: request.method,
          headers,
          ...(request.body ? { body: JSON.stringify(request.body) } : {}),
        });
        const response = await auth.handler(authRequest);
        reply.status(response.status);
        response.headers.forEach((value, key) => {
          if (key.toLowerCase() !== "set-cookie") reply.header(key, value);
        });
        const cookies = response.headers.getSetCookie();
        if (cookies.length > 0) reply.header("set-cookie", cookies);
        return reply.send(response.body ? Buffer.from(await response.arrayBuffer()) : null);
      } catch {
        request.log.error("Better Auth request failed");
        return reply.status(500).send({ error: "Authentication request failed" });
      }
    },
  });
}
