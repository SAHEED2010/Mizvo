import { healthResponseSchema } from "@mizvo/shared-schemas";
import type { HealthResponse } from "@mizvo/shared-types";
import Fastify from "fastify";
import { registerAuthRoutes } from "./auth/fastify.js";
import type { SmsTransport } from "./auth/sms.js";

export function buildApp(
  env: NodeJS.ProcessEnv = process.env,
  options: { smsTransport?: SmsTransport } = {},
) {
  const trustedProxies = (env.TRUSTED_PROXY_CIDRS ?? "")
    .split(",")
    .map((range) => range.trim())
    .filter(Boolean);
  const app = Fastify({
    logger: false,
    trustProxy: trustedProxies.length ? trustedProxies : false,
  });

  app.get<{ Reply: HealthResponse }>("/health", async (_request, reply) => {
    const response: HealthResponse = { status: "ok" };
    healthResponseSchema.parse(response);
    return reply.send(response);
  });

  registerAuthRoutes(app, env, options);

  return app;
}
