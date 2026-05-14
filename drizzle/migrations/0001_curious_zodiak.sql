CREATE TABLE "ai_analysis_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_key" text NOT NULL,
	"target_message_ids" text NOT NULL,
	"model" text NOT NULL,
	"request_tokens_estimate" integer,
	"response_raw" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" bigint NOT NULL,
	"completed_at" bigint
);
--> statement-breakpoint
CREATE INDEX "idx_ai_analysis_runs_conversation_key" ON "ai_analysis_runs" USING btree ("conversation_key");--> statement-breakpoint
CREATE INDEX "idx_ai_analysis_runs_status" ON "ai_analysis_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_ai_analysis_runs_created_at" ON "ai_analysis_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_attachments_channel_created" ON "attachments" USING btree ("channel_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_attachments_thread_created" ON "attachments" USING btree ("thread_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_messages_channel_created" ON "messages" USING btree ("channel_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_messages_thread_created" ON "messages" USING btree ("thread_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_messages_ai_status_created" ON "messages" USING btree ("ai_status","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_messages_guild_ai_status_created" ON "messages" USING btree ("guild_id","ai_status","created_at","id");