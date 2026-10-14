import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createAuth } from "./auth.js";

export function registerAuthRoutes(
  app: FastifyInstance,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.AUTH_ENABLED !== "true") return;

  const auth = createAuth(env);
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async handler(request: FastifyRequest, reply: FastifyReply) {
      try {
        const baseURL = env.BETTER_AUTH_URL;
        if (!baseURL) throw new Error("BETTER_AUTH_URL is required");
        const requestUrl = new URL(request.url, baseURL);
        const headers = fromNodeHeaders(request.headers);
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
