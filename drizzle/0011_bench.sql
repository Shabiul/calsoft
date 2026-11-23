ALTER TABLE "event_type" ALTER COLUMN "reminders" SET DEFAULT '[0,10]'::jsonb;--> statement-breakpoint
ALTER TABLE "organization_member" ADD COLUMN "manager_user_id" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "last_active_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "bench" jsonb;--> statement-breakpoint
ALTER TABLE "organization_member" ADD CONSTRAINT "organization_member_manager_user_id_user_id_fk" FOREIGN KEY ("manager_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;