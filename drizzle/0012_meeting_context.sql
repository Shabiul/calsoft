CREATE TABLE "meeting_context" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"event_type_id" uuid NOT NULL,
	"created_by_user_id" text NOT NULL,
	"notes" text NOT NULL,
	"booking_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_context_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "scheduled_by_user_id" text;--> statement-breakpoint
ALTER TABLE "meeting_context" ADD CONSTRAINT "meeting_context_event_type_id_event_type_id_fk" FOREIGN KEY ("event_type_id") REFERENCES "public"."event_type"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_context" ADD CONSTRAINT "meeting_context_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_context" ADD CONSTRAINT "meeting_context_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_scheduled_by_user_id_user_id_fk" FOREIGN KEY ("scheduled_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;