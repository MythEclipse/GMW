# AI Message Flow + React Dashboard Redesign

## Goal

Rebuild the moderation watcher flow so message capture is fast, AI analysis is contextual and reliable, APIs are split by concern, and the dashboard is maintainable. The implementation may fully replace the current static frontend and reorganize backend modules, while preserving existing voice functionality.

## Current Problems

- Message capture, AI queuing, DB access, and WebSocket broadcasting are tightly coupled.
- AI analysis batches depend on array ordering, which can mismatch results when the model returns malformed or partial JSON.
- Pending analysis is polled globally, not grouped by conversation, so context is weak and request efficiency is inconsistent.
- `/api/messages` mixes text/image concerns and uses offset pagination, which gets slower and less stable as rows grow.
- Frontend is a large static HTML file with inline state, API, WebSocket, rendering, and audio code.
- WebSocket broadcast uses untyped `globalThis` hooks across modules.

## Backend Architecture

### Message ingestion

`messageCapture` becomes a narrow ingestion layer:

1. Filter Discord events by guild and author.
2. Normalize message payload and metadata.
3. Upsert message/attachment records.
4. Set or reset `ai_status` to `pending` for new or edited text.
5. Emit typed domain events for WebSocket broadcasting and analysis queueing.

It should not build prompts, manage AI batches, or query unrelated DB state.

### Store/repository layer

`messageStore` becomes the single message/attachment query boundary. It should expose focused functions:

- `upsertMessage`
- `markMessageEdited`
- `markMessageDeleted`
- `listMessages`
- `listReviewMessages`
- `getConversationContext`
- `claimPendingMessagesForChannel`
- `saveAnalysisResults`
- `insertAttachments`

Queries should use cursor pagination based on `(created_at, id)` instead of offset pagination. Common filters: `guildId`, `channelId`, `threadId`, `status`, `userId`, `q`, `limit`, `cursor`.

### Analysis queue

Add an `analysisQueue` module. It owns async AI processing and keeps capture fast.

- Queue key: `thread_id ?? channel_id`.
- Debounce: 1–3 seconds per key to group nearby messages.
- Batch pending messages by conversation key and token budget.
- Only one or a small fixed number of active LLM requests.
- Backlog worker feeds the same queue; no separate analysis path.
- Edits reset a message to `pending` and enqueue its conversation key.

If the process restarts, pending rows are recovered by a periodic lightweight scanner grouped by conversation key.

### Conversation context builder

Add `conversationContext` module:

- Input: conversation key + target pending messages.
- Fetch context before the first target message, normally 20 prior messages.
- Include target messages and close neighboring messages when within budget.
- Mark target messages explicitly in the prompt.
- Keep context scoped to one channel/thread to avoid irrelevant noise.

### LLM moderation client

Add `llmModerationClient` module:

- Own request shape, timeout, retry, JSON extraction, and validation.
- Prompt returns JSON keyed by `message_id`, not positional arrays.
- Expected response shape:
  ```json
  {
    "results": [
      {
        "message_id": "string",
        "status": "clean|warn|flagged",
        "flags": ["string"],
        "score": 0.0,
        "analysis": "Bahasa Indonesia summary + reason + suggested action"
      }
    ]
  }
  ```
- Reject unknown IDs, invalid statuses, invalid scores, and missing target IDs.
- On partial model failure, retry once with smaller batch. If still invalid, mark only affected target messages as `error`.
- Store raw batch request/response in one run record if the DB migration is included; otherwise store compact raw metadata per message.

## API Design

Split API by use case so reads remain fast and obvious.

### Message read APIs

- `GET /api/messages`
  - Query: `guildId`, `channelId`, `threadId`, `cursor`, `limit`, `status`, `userId`, `q`.
  - Returns: `{ data, nextCursor }`.
  - Uses indexed cursor pagination.

- `GET /api/messages/:id`
  - Returns one message with attachments and AI analysis.

- `GET /api/review`
  - Query: `guildId`, optional `channelId`, `status=warn,flagged,error`, `cursor`, `limit`.
  - Optimized for moderator review panel.

- `GET /api/attachments`
  - Query: `channelId`, `threadId`, `cursor`, `limit`, `type`.
  - Replaces image mode inside `/api/messages`.

### Analysis APIs

- `POST /api/messages/:id/reanalyze`
  - Sets message to `pending` and queues its conversation.
  - Returns `202 Accepted` with current message status.

- `POST /api/analysis/requeue-pending`
  - Admin/manual recovery endpoint for pending/error rows.
  - Returns count queued.

- `GET /api/analysis/status`
  - Returns queue depth, active requests, last error, and pending counts.

### Discord sync APIs

- `POST /api/backlog-sync`
  - Stays async-friendly: starts sync for guild/channel/thread and returns `202` with a job id or immediate summary if small.
  - Sync inserts messages, then queues analysis through the same `analysisQueue`.

### Voice/control APIs

Keep existing voice APIs working, but move route registration into route modules:

- `routes/voiceRoutes.ts`
- `routes/messageRoutes.ts`
- `routes/analysisRoutes.ts`
- `routes/syncRoutes.ts`
- `routes/uiStateRoutes.ts`

`webserver.ts` should only create Express/WS server, install middleware, register routes, and start listening.

## WebSocket Design

Replace ad-hoc globals with a typed broadcaster module.

Events:

- `ui_state`
- `user_state`
- `message_created`
- `message_updated`
- `message_deleted`
- `message_analyzed`
- `attachment_created`
- `analysis_queue_status`

Backend modules call broadcaster functions; they do not touch WebSocket clients directly.

## Database Changes

Add or verify indexes:

- messages `(channel_id, created_at, id)`
- messages `(thread_id, created_at, id)`
- messages `(ai_status, created_at, id)`
- messages `(guild_id, ai_status, created_at, id)`
- attachments `(channel_id, created_at, id)`
- attachments `(thread_id, created_at, id)`

Optional but preferred:

- `ai_analysis_runs` table:
  - `id`
  - `conversation_key`
  - `target_message_ids`
  - `model`
  - `request_tokens_estimate`
  - `response_raw`
  - `status`
  - `error`
  - `created_at`
  - `completed_at`

This avoids duplicating large raw LLM responses into every message row.

## React/Vite Frontend

Replace static inline dashboard code with a TypeScript React app.

Suggested structure:

- `frontend/src/api/` — typed REST clients
- `frontend/src/ws/` — WebSocket client and event types
- `frontend/src/state/` — small hooks for selected guild/channel, messages, review queue, voice state
- `frontend/src/components/voice/` — existing voice control/audio components
- `frontend/src/components/messages/` — feed, message card, filters, detail drawer
- `frontend/src/components/review/` — needs-review list and analysis status
- `frontend/src/components/layout/` — shell/sidebar/status cards

UI layout:

- Left sidebar: guild, voice channel, text channel/thread, connection state.
- Main area: message feed with filters and load-more cursor pagination.
- Right panel: review queue for `warn`, `flagged`, and `error` messages.
- Detail drawer/modal: message metadata, attachments, AI rationale, raw flags, reanalyze action.

Voice features stay functionally equivalent. Audio capture/playback code can be moved into React hooks but should not be behaviorally rewritten unless needed.

Build integration:

- Add Vite dev/build scripts.
- Express serves the built app from a stable public directory in production.
- During development, either run Vite separately or proxy API/WS to Express.

## Performance Rules

- Message capture must not wait on AI.
- Read APIs use cursor pagination and indexes.
- AI batches are bounded by token estimate and message count.
- UI fetches initial pages, then patches via WebSocket.
- Backlog sync should not block dashboard interactions.
- Avoid storing full raw LLM response per message when a batch table is available.

## Error Handling

- Capture errors log and do not crash Discord client event handlers.
- AI request failures mark target messages `error` with a short reason.
- Invalid LLM JSON triggers retry/split before marking errors.
- API validation returns 400 with structured error code.
- WebSocket reconnect logic stays client-side.
- Manual reanalysis provides recovery for bad AI results.

## Testing

Backend:

- Unit tests for conversation context selection.
- Unit tests for LLM response parser and validation.
- Unit tests for queue batching/debounce behavior.
- Integration tests for message cursor pagination and review filters.
- Existing voice tests remain unchanged.

Frontend:

- Typecheck and Vite build.
- Component-level smoke tests may be added if test tooling is already practical.
- Manual browser verification: channel select, message feed, review panel, WebSocket updates, reanalyze action, voice controls.

## Implementation Scope

This is a full redesign of the message/AI/dashboard path. Voice recording and live audio behavior should be preserved unless a change is required to integrate the React dashboard.

Implementation should proceed incrementally:

1. Backend boundaries and typed broadcaster.
2. Store/query improvements and indexes.
3. Analysis queue/context/client rewrite.
4. Split API routes.
5. React/Vite dashboard.
6. Verification and cleanup of old static dashboard code.
