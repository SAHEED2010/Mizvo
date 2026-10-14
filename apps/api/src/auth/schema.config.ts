import { betterAuth } from "better-auth";
import { createAuthPlugins } from "./plugins.js";

// Better Auth's CLI reads this config to generate the Drizzle tables for the
// same plugins used by the Fastify server. No database connection is opened.
export const auth = betterAuth({
  baseURL: "http://127.0.0.1:4000",
  plugins: [...createAuthPlugins()],
});
