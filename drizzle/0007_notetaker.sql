CREATE TABLE "meeting_note" (
	"booking_id" uuid PRIMARY KEY NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"transcript" text,
	"summary" text,
	"bot_status" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event_type" ADD COLUMN "notetaker_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting_note" ADD CONSTRAINT "meeting_note_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE cascade ON UPDATE no action;