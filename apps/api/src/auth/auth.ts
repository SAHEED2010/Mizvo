import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { createDatabase } from "@mizvo/database";
import * as schema from "@mizvo/database/schema/auth";
import { betterAuth } from "better-auth";
import { createAuthPlugins } from "./plugins.js";

export function createAuth(env: NodeJS.ProcessEnv = process.env) {
  const databaseUrl = env.DATABASE_URL;
  const secret = env.BETTER_AUTH_SECRET;
  const baseURL = env.BETTER_AUTH_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required when AUTH_ENABLED=true");
  if (!secret || secret.length < 32)
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  if (!baseURL) throw new Error("BETTER_AUTH_URL is required when AUTH_ENABLED=true");

  const database = createDatabase(databaseUrl);
  return betterAuth({
    appName: "Mizvo",
    baseURL,
    secret,
    database: drizzleAdapter(database.db, {
      provider: "pg",
      schema,
    }),
    emailAndPassword: { enabled: false },
    plugins: [...createAuthPlugins()],
    trustedOrigins: (env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  });
}
