ALTER TABLE "step_up_challenge" ADD COLUMN "credential_counter" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "step_up_challenge" ADD CONSTRAINT "step_up_challenge_counter_nonnegative" CHECK ("step_up_challenge"."credential_counter" >= 0);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "mizvo_bump_step_up_test_epoch_on_membership_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE "step_up_test_identity"
    SET "security_epoch" = "security_epoch" + 1
    WHERE "user_id" = NEW."user_id";
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE "step_up_test_identity"
    SET "security_epoch" = "security_epoch" + 1
    WHERE "user_id" = OLD."user_id";
    RETURN OLD;
  ELSIF OLD."role" IS DISTINCT FROM NEW."role"
    OR OLD."organization_id" IS DISTINCT FROM NEW."organization_id"
    OR OLD."user_id" IS DISTINCT FROM NEW."user_id" THEN
    UPDATE "step_up_test_identity"
    SET "security_epoch" = "security_epoch" + 1
    WHERE "user_id" = OLD."user_id";
    IF NEW."user_id" IS DISTINCT FROM OLD."user_id" THEN
      UPDATE "step_up_test_identity"
      SET "security_epoch" = "security_epoch" + 1
      WHERE "user_id" = NEW."user_id";
    END IF;
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "member_step_up_test_epoch"
AFTER INSERT OR UPDATE OR DELETE ON "member"
FOR EACH ROW EXECUTE FUNCTION "mizvo_bump_step_up_test_epoch_on_membership_change"();
