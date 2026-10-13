import { healthResponseSchema } from "@mizvo/shared-schemas";
import type { HealthResponse } from "@mizvo/shared-types";
import Fastify from "fastify";

export function buildApp() {
  const app = Fastify({ logger: false });

  app.get<{ Reply: HealthResponse }>("/health", async (_request, reply) => {
    const response: HealthResponse = { status: "ok" };
    healthResponseSchema.parse(response);
    return reply.send(response);
  });

  return app;
}
