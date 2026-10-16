ALTER TABLE "recovery_capability" ADD COLUMN "verifier" text NOT NULL;--> statement-breakpoint
ALTER TABLE "recovery_capability" ADD COLUMN "key_version" text NOT NULL;--> statement-breakpoint
ALTER TABLE "recovery_capability" ADD CONSTRAINT "recovery_capability_verifier_format" CHECK ("recovery_capability"."verifier" ~ '^[0-9a-f]{64}$');