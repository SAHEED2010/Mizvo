import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  createStepUpTestService,
  StepUpTestServiceConfigurationError,
} from "./step-up-test-service.js";

describe("C3c internal verifier configuration boundary", () => {
  it("rejects non-loopback hosts before opening a database connection", async () => {
    const client = postgres("postgres://user:password@db.example.test/mizvo_test", { max: 1 });
    try {
      expect(() => createStepUpTestService({ client })).toThrow(
        StepUpTestServiceConfigurationError,
      );
      expect(() => createStepUpTestService({ client })).toThrow(/loopback.*mizvo_test/i);
    } finally {
      await client.end();
    }
  });

  it("rejects a loopback database with any name other than mizvo_test", async () => {
    const client = postgres("postgres://user:password@127.0.0.1:5432/production", { max: 1 });
    try {
      expect(() => createStepUpTestService({ client })).toThrow(
        StepUpTestServiceConfigurationError,
      );
      expect(() => createStepUpTestService({ client })).toThrow(/loopback.*mizvo_test/i);
    } finally {
      await client.end();
    }
  });

  it("rejects service construction outside the test environment", async () => {
    const client = postgres("postgres://user:password@127.0.0.1:5432/mizvo_test", { max: 1 });
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      expect(() => createStepUpTestService({ client })).toThrow(/test-only/i);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      await client.end();
    }
  });
});
