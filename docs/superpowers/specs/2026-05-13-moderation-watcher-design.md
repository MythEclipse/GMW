# Moderation Watcher Expansion Design

**Date:** 2026-05-13  
**Status:** Design Phase  
**Scope:** Expand Discord bot from voice-only recorder to full moderation watcher capturing text, images, and voice

## Overview

Transform the existing voice recorder bot into a unified moderation watcher that captures:
- **Voice:** Audio from voice channels (existing)
- **Text:** Messages (new/edited/deleted) from all channels and threads
- **Images:** Attachments uploaded to all channels and threads

All data stored in SQLite database. Attachments uploaded to external picser service. Unified dashboard with separate tabs for each content type, filterable by channel/thread.

## Requirements

### Functional

1. **Text Message Capture**
   - Capture new messages: content, author, channel, timestamp
   - Capture edited messages: original + edited content, edit timestamp
   - Capture deleted messages: content, author, deletion timestamp
   - Store in database with full metadata

2. **Image/Attachment Capture**
   - Detect attachments in messages
   - Upload to `https://picser.asepharyana.tech/api/upload`
   - Store `raw_commit` URL in database
   - Store attachment metadata: filename, size, type, upload timestamp

3. **Voice Recording** (existing, no changes)
   - Continue recording voice segments as-is
   - Segments already stored in database via muxer queue

4. **Dashboard API**
   - `/api/messages?channel=<id>&type=text|image|voice` — Query messages by type and channel
   - `/api/channels` — List all monitored channels
   - Real-time WebSocket updates: `message_created`, `message_updated`, `message_deleted`, `attachment_uploaded`

5. **Dashboard UI**
   - Three tabs: Voice | Text | Images
   - Channel/thread filter dropdown
   - Display messages/attachments with metadata (author, timestamp, content)
   - Real-time updates via WebSocket, polling fallback

### Non-Functional

- **Target Server:** Configured via `MONITOR_GUILD_ID` environment variable
- **Database:** Single SQLite (`.muxer-queue.db`), extended schema
- **Attachment Upload:** Async, non-blocking; store URL when ready
- **Real-time:** WebSocket for live updates, REST polling as fallback
- **Performance:** Index on channel_id, user_id, created_at for fast queries

## Architecture

### Database Schema

**New Tables:**

```sql
-- Text messages
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_id TEXT,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  avatar_url TEXT,
  content TEXT NOT NULL,
  edited_content TEXT,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER,
  type TEXT NOT NULL DEFAULT 'text', -- 'text', 'edited', 'deleted'
  metadata TEXT -- JSON: roles, etc.
);

CREATE INDEX idx_messages_channel ON messages(channel_id);
CREATE INDEX idx_messages_user ON messages(user_id);
CREATE INDEX idx_messages_created ON messages(created_at DESC);
CREATE INDEX idx_messages_thread ON messages(thread_id);

-- Attachments
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  type TEXT NOT NULL, -- MIME type
  discord_url TEXT NOT NULL,
  uploaded_url TEXT, -- picser raw_commit URL
  upload_status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'uploaded', 'failed'
  upload_error TEXT,
  created_at INTEGER NOT NULL,
  uploaded_at INTEGER,
  FOREIGN KEY (message_id) REFERENCES messages(id)
);

CREATE INDEX idx_attachments_channel ON attachments(channel_id);
CREATE INDEX idx_attachments_message ON attachments(message_id);
CREATE INDEX idx_attachments_status ON attachments(upload_status);
```

### Event Handlers

**New Discord Event Listeners:**

1. `messageCreate` — Insert into `messages` table
2. `messageUpdate` — Update `messages` table with edited content + timestamp
3. `messageDelete` — Mark message as deleted (soft delete with `deleted_at`)
4. `messageReactionAdd` — (Optional: track reactions)

**Attachment Processing:**

- On `messageCreate`: Extract attachments, insert into `attachments` table with `upload_status='pending'`
- Async job: Download from Discord URL, upload to picser, update `uploaded_url` and `upload_status`
- If upload fails: Set `upload_status='failed'`, store error message

### API Endpoints

**REST:**

```
GET /api/messages?channel=<id>&type=text|image|voice&limit=50&offset=0
  → Returns paginated messages/attachments

GET /api/channels
  → Returns list of all channels in monitored guild

GET /api/attachments?channel=<id>&limit=50
  → Returns attachments with upload status
```

**WebSocket Events (outbound):**

```json
{
  "type": "message_created",
  "data": { "id", "channel_id", "user_id", "username", "content", "created_at" }
}

{
  "type": "message_updated",
  "data": { "id", "edited_content", "edited_at" }
}

{
  "type": "message_deleted",
  "data": { "id", "deleted_at" }
}

{
  "type": "attachment_uploaded",
  "data": { "id", "message_id", "filename", "uploaded_url", "created_at" }
}
```

### File Structure

```
src/
  ├── moderation/
  │   ├── messageCapture.ts      -- Discord event listeners
  │   ├── attachmentUploader.ts  -- Upload to picser, manage queue
  │   ├── messageStore.ts        -- Database operations
  │   └── types.ts               -- Message/Attachment types
  ├── webserver.ts               -- Add /api/messages, /api/channels endpoints
  ├── index.ts                   -- Register message event listeners
  └── config.ts                  -- Add MONITOR_GUILD_ID
```

### Configuration

**New Environment Variables:**

```env
MONITOR_GUILD_ID=<guild-id>           # Target server to monitor
PICSER_UPLOAD_URL=https://picser.asepharyana.tech/api/upload
ATTACHMENT_UPLOAD_TIMEOUT_MS=30000    # Upload timeout
ATTACHMENT_MAX_SIZE_MB=100            # Max file size to upload
```

## Implementation Phases

### Phase 1: Database & Core Capture
- Extend SQLite schema (messages, attachments tables)
- Implement message capture handlers (create/edit/delete)
- Add message store functions (insert, update, query)

### Phase 2: Attachment Upload
- Implement picser uploader with retry logic
- Add attachment processing queue
- Store URLs in database

### Phase 3: API & WebSocket
- Add REST endpoints for querying messages/attachments
- Add WebSocket events for real-time updates
- Implement channel listing

### Phase 4: Dashboard UI
- Build frontend with Voice | Text | Images tabs
- Implement channel filter
- Add real-time WebSocket listener + polling fallback

## Error Handling

- **Upload failures:** Retry with exponential backoff, store error in `upload_error` field
- **Database errors:** Log and continue (don't crash bot)
- **Missing attachments:** Handle Discord URL expiry gracefully
- **WebSocket disconnects:** Clients reconnect and poll for missed messages

## Testing

- Unit tests for message store functions (insert, update, query)
- Integration tests for attachment uploader (mock picser API)
- E2E tests for Discord event capture (mock Discord client)

## Success Criteria

- ✅ All text messages captured (new/edited/deleted)
- ✅ All attachments uploaded to picser with URLs stored
- ✅ Dashboard displays all three content types in separate tabs
- ✅ Channel filter works correctly
- ✅ Real-time WebSocket updates working
- ✅ Polling fallback works if WebSocket disconnects
- ✅ No data loss on bot restart
- ✅ Graceful handling of upload failures

## Future Enhancements

- Reaction tracking
- Message search/full-text search
- Moderation actions (flag, delete, mute)
- Export/archive functionality
- Retention policies (auto-delete old data)
