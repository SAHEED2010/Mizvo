import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { createDatabase } from "@mizvo/database";
import * as schema from "@mizvo/database/schema/auth";
import { betterAuth } from "better-auth";
import { eq } from "drizzle-orm";
import { createAuthPlugins } from "./plugins.js";
import type { SmsTransport } from "./sms.js";
import { createOtpSmsTransport } from "./sms-provider.js";

export function createAuth(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    smsTransport?: SmsTransport;
    database?: ReturnType<typeof createDatabase>;
  } = {},
) {
  const databaseUrl = env.DATABASE_URL;
  const secret = env.BETTER_AUTH_SECRET;
  const baseURL = env.BETTER_AUTH_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required when AUTH_ENABLED=true");
  if (!secret || secret.length < 32)
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  if (!baseURL) throw new Error("BETTER_AUTH_URL is required when AUTH_ENABLED=true");

  const database = options.database ?? createDatabase(databaseUrl);
  return betterAuth({
    appName: "Mizvo",
    baseURL,
    secret,
    database: drizzleAdapter(database.db, {
      provider: "pg",
      schema,
    }),
    emailAndPassword: { enabled: false },
    user: { changeEmail: { enabled: false } },
    session: { expiresIn: 7 * 24 * 60 * 60, disableSessionRefresh: true },
    rateLimit: {
      enabled: true,
      storage: "database",
      // Keep Better Auth's rate-limit cleanup horizon at least as long as
      // the additional 15-minute hashed phone/IP delivery buckets.
      window: 15 * 60,
      max: 1000,
      customRules: {
        "/phone-number/send-otp": { window: 60, max: 10 },
        "/phone-number/verify": { window: 60, max: 30 },
      },
    },
    advanced: {
      useSecureCookies: env.NODE_ENV === "production",
      defaultCookieAttributes: {
        httpOnly: true,
        secure: env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
      },
      ipAddress: { ipAddressHeaders: ["x-mizvo-client-ip"] },
    },
    databaseHooks: {
      verification: {
        create: {
          async after(verification) {
            // Better Auth retains a wrong-code counter of 3 until one more
            // request arrives. Delete at the limit so the fourth attempt is
            // not needed to invalidate this code.
            if (
              /^\+234[789]\d{9}$/.test(verification.identifier) &&
              /^\d{6}:3$/.test(verification.value)
            ) {
              await database.db
                .delete(schema.verification)
                .where(eq(schema.verification.identifier, verification.identifier));
            }
          },
        },
      },
    },
    plugins: [...createAuthPlugins(options.smsTransport ?? createOtpSmsTransport(env))],
    trustedOrigins: (env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  });
}
