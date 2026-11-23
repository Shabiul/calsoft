ALTER TABLE "meeting_note" ADD COLUMN "bot_id" text;--> statement-breakpoint
ALTER TABLE "meeting_note" ADD COLUMN "attendance" jsonb;--> statement-breakpoint
ALTER TABLE "meeting_note" ADD COLUMN "chat" jsonb;--> statement-breakpoint
ALTER TABLE "meeting_note" ADD COLUMN "action_items" jsonb;--> statement-breakpoint
ALTER TABLE "meeting_note" ADD COLUMN "recording_expires_at" timestamp with time zone;