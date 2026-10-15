import { createDatabase } from "@mizvo/database";
import { passkey } from "@mizvo/database/schema/auth";
import { fromNodeHeaders } from "better-auth/node";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import postgres from "postgres";
import { registerBusinessRoutes } from "../businesses.js";
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
  registerBusinessRoutes(app, auth, database, trustedOrigins);
  const developmentPasskeysEnabled =
    env.NODE_ENV === "development" &&
    env.MIZVO_PASSKEY_ENROLLMENT === "development" &&
    trustedOrigins.has("http://localhost:3000");

  app.get("/api/security/passkeys", async (request, reply) => {
    if (!developmentPasskeysEnabled) return reply.status(404).send({ message: "Not found" });
    if (
      (request.headers.origin && request.headers.origin !== "http://localhost:3000") ||
      request.headers["sec-fetch-site"] === "cross-site"
    ) {
      return reply.status(403).send({ message: "Origin is not allowed" });
    }
    reply.header("cache-control", "no-store");
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session) return reply.status(401).send({ error: "authentication_required" });
    if (session.user.phoneNumberVerified !== true)
      return reply.status(403).send({ error: "verified_phone_required" });
    const records = await database.db
      .select({ id: passkey.id, name: passkey.name, createdAt: passkey.createdAt })
      .from(passkey)
      .where(eq(passkey.userId, session.user.id));
    return reply.send({ passkeys: records });
  });

  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async preHandler(request: FastifyRequest, reply: FastifyReply) {
      let path: string;
      try {
        path = decodeURIComponent(new URL(request.url, "http://localhost").pathname)
          .replace(/\\+/g, "/")
          .replace(/\/+$/, "")
          .toLowerCase();
      } catch {
        return reply.status(404).send({ message: "Not found" });
      }
      // Keep the full browser-facing Organization plugin namespace blocked for
      // every method; only the reviewed C1 business routes use server-side APIs.
      if (path === "/api/auth/organization" || path.startsWith("/api/auth/organization/")) {
        return reply.status(404).send({ message: "Not found" });
      }
      if (path === "/api/auth/passkey" || path.startsWith("/api/auth/passkey/")) {
        const registrationRoute =
          (request.method === "GET" && path === "/api/auth/passkey/generate-register-options") ||
          (request.method === "POST" && path === "/api/auth/passkey/verify-registration");
        if (!developmentPasskeysEnabled || !registrationRoute)
          return reply.status(404).send({ message: "Not found" });
        reply.header("cache-control", "no-store");

        const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
        if (!session) return reply.status(401).send({ error: "authentication_required" });
        if (session.user.phoneNumberVerified !== true)
          return reply.status(403).send({ error: "verified_phone_required" });

        // WebAuthn verification is a cookie-authenticated state change. Accept
        // only the exact local browser origin, independently of the API proxy
        // host (127.0.0.1:4000).
        if (request.method === "POST") {
          if (request.headers.origin !== "http://localhost:3000")
            return reply.status(403).send({ message: "Origin is not allowed" });
          const body = request.body;
          if (body && typeof body === "object") {
            if (
              ("createSession" in body && body.createSession !== false) ||
              "userId" in body ||
              "context" in body
            ) {
              return reply.status(400).send({ message: "Registration options are not allowed" });
            }
          }
        }
        return;
      }
      if (request.method !== "POST") return;

      const origin = request.headers.origin;
      if (!origin || !trustedOrigins.has(origin)) {
        return reply.status(403).send({ message: "Origin is not allowed" });
      }

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
