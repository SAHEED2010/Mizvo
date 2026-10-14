import { healthResponseSchema } from "@mizvo/shared-schemas";
import type { HealthResponse } from "@mizvo/shared-types";
import Fastify from "fastify";
import { registerAuthRoutes } from "./auth/fastify.js";

export function buildApp(env: NodeJS.ProcessEnv = process.env) {
  const app = Fastify({ logger: false });

  app.get<{ Reply: HealthResponse }>("/health", async (_request, reply) => {
    const response: HealthResponse = { status: "ok" };
    healthResponseSchema.parse(response);
    return reply.send(response);
  });

  registerAuthRoutes(app, env);

  return app;
}
