ALTER TYPE "public"."org_role" ADD VALUE 'manager';--> statement-breakpoint
ALTER TYPE "public"."org_role" ADD VALUE 'team_lead';--> statement-breakpoint
CREATE TABLE "sign_in_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"provider" text,
	"device" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sign_in_log" ADD CONSTRAINT "sign_in_log_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sign_in_log_user_idx" ON "sign_in_log" USING btree ("user_id","created_at");