# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Discord Moderation Watcher Bot** — A comprehensive monitoring bot that captures voice, text messages, and images from Discord servers. Records audio from voice channels, captures all text messages (new/edited/deleted) from channels and threads, and uploads attachments to external storage. All data stored in SQLite with real-time dashboard.

Built with **Node.js/pnpm** + **discord.js-selfbot-v13** + **@discordjs/voice** + **Express** + **WebSocket**.

## Architecture

### High-Level Flow

1. **Bot Entry** (`src/index.ts`) — Initializes Discord client, registers event listeners, starts webserver
2. **Message Capture** (`src/moderation/messageCapture.ts`) — Listens to Discord events (messageCreate, messageUpdate, messageDelete)
3. **Message Store** (`src/moderation/messageStore.ts`) — Database operations for messages and attachments
4. **Attachment Uploader** (`src/moderation/attachmentUploader.ts`) — Downloads from Discord, uploads to picser, stores URLs
5. **Voice Controller** (`src/voiceController.ts`) — Manages voice channel connections
6. **Recorder** (`src/recorder.ts`) — Records voice audio to OGG segments
7. **Web Server** (`src/webserver.ts`) — Express + WebSocket for REST API and real-time updates
8. **Dashboard** (`public/dashboard.html`) — Web UI with three tabs (Text, Images, Voice)

### Key Modules

**Moderation Subsystem** (`src/moderation/`):
- `types.ts` — TypeScript types for messages, attachments, voice segments
- `messageCapture.ts` — Discord event listeners (messageCreate, messageUpdate, messageDelete)
- `messageStore.ts` — Database CRUD operations (insert, update, query)
- `attachmentUploader.ts` — Picser integration with retry logic and error handling

**Database Schema** (SQLite):
- `messages` table — text messages with edit/delete tracking, user metadata, timestamps
- `attachments` table — attachment metadata, Discord URLs, picser URLs, upload status
- Indexes on channel_id, user_id, created_at for fast queries

**Voice Recording** (existing, unchanged):
- `recorder.ts` — Joins voice channel, subscribes to user audio streams
- `recorder/audioStream.ts` — Opus packet subscription
- `recorder/decoder.ts` — Opus decoder with runtime checks
- `recorder/segment.ts` — OGG file rotation (5s segments)

**Web Interface**:
- REST API: `/api/messages?channel=<id>&type=text|image`
- WebSocket: real-time events (message_created, message_updated, message_deleted, attachment_uploaded)
- Dashboard: three tabs (Text Messages, Images, Voice) with channel filtering

### Recording Structure

```
recordings/
  ├── <user-id>/
  │   ├── <user-id>-<session-start>-0.ogg
  │   ├── <user-id>-<session-start>-0.json
  │   └── ...

messages (SQLite):
  ├── id, guild_id, channel_id, thread_id
  ├── user_id, username, avatar_url
  ├── content, edited_content
  ├── created_at, edited_at, deleted_at
  └── type (text|edited|deleted)

attachments (SQLite):
  ├── id, message_id, guild_id, channel_id, user_id
  ├── filename, size, type (MIME)
  ├── discord_url, uploaded_url (picser raw_commit)
  ├── upload_status (pending|uploaded|failed)
  └── created_at, uploaded_at
```

## Development Commands

```bash
# Install dependencies
pnpm install

# Development (auto-restart on file changes)
pnpm run dev

# Production
pnpm run start

# Type checking
pnpm run typecheck

# Linting (Biome)
pnpm run lint

# Format code (Biome)
pnpm run format

# Run tests
pnpm run test

# Build TypeScript
pnpm run build
```

## Configuration

All config via `.env` (see `.env.example`). Key variables:

**Discord & Monitoring:**
- `DISCORD_TOKEN` — Bot token (required)
- `MONITOR_GUILD_ID` — Target server to monitor (required for moderation)
- `GUILD_ID` — Legacy voice channel guild (optional)
- `VOICE_CHANNEL_ID` — Legacy voice channel ID (optional)

**Recording:**
- `RECORDINGS_DIR` — Where to save audio files (default: `./recordings`)
- `RECORDING_SEGMENT_MS` — OGG segment duration (default: 5000ms)

**Decoder:**
- `DECODER_ROTATE_MS` — Opus decoder rotation interval (default: 5000ms)
- `DECODER_COOLDOWN_MS` — Cooldown after decoder error (default: 30000ms)

**Attachments:**
- `PICSER_UPLOAD_URL` — Picser upload endpoint (default: https://picser.asepharyana.tech/api/upload)
- `ATTACHMENT_UPLOAD_TIMEOUT_MS` — Upload timeout (default: 30000ms)
- `ATTACHMENT_MAX_SIZE_MB` — Max file size (default: 100MB)
- `ATTACHMENT_RETRY_ATTEMPTS` — Retry count (default: 3)

**Web Server:**
- `WEBSERVER_PORT` — HTTP/WebSocket port (default: 3000)

**Connection:**
- `VOICE_CONNECTION_TIMEOUT_MS` — Voice join timeout (default: 15000ms)
- `RECONNECT_TIMEOUT_MS` — Reconnect timeout (default: 5000ms)
- `AUDIO_STREAM_SILENCE_DURATION_MS` — Silence threshold (default: 3000ms)

**Logging:**
- `LOG_LEVEL` — Pino log level (default: info)
- `VERBOSE` — Enable debug logging (default: false)
- `NODE_ENV` — Environment (development|production|test)

## Testing

Tests use **Vitest** in `tests/` directory. Run with `pnpm run test`.

**Test Coverage:**
- `tests/moderation/messageStore.test.ts` — Message store CRUD operations
- `tests/moderation/attachmentUploader.test.ts` — Picser response parsing
- `tests/config.test.ts` — Configuration validation
- `tests/decoder.test.ts` — Opus decoder runtime detection

## Code Style

- **Formatter**: Biome (2-space indent)
- **Linter**: Biome with custom rules (warn on non-null assertions, noExplicitAny)
- **Language**: TypeScript with strict mode
- **Logging**: Use `createChildLogger(context)` for scoped logs
- **Errors**: Throw custom AppError subclasses with code + statusCode
- **Database**: Use prepared statements, never string interpolation

## Key Patterns

### Message Capture Lifecycle

1. Discord event fires (messageCreate, messageUpdate, messageDelete)
2. Check if guild matches MONITOR_GUILD_ID
3. Extract message metadata (user, channel, content, timestamp)
4. Insert into messages table
5. Broadcast WebSocket event to connected clients
6. If attachments exist:
   - Insert into attachments table with status='pending'
   - Start async upload to picser (non-blocking)
   - On success: update uploaded_url, status='uploaded'
   - On failure: store error, status='failed'

### Attachment Upload Flow

1. Download from Discord URL (with timeout)
2. Validate file size against ATTACHMENT_MAX_SIZE_MB
3. Upload to picser with retry logic (exponential backoff)
4. Parse response, extract raw_commit URL
5. Update database with uploaded_url and status
6. Broadcast attachment_uploaded event

### WebSocket Protocol

**Inbound (browser → bot):**
- Binary: Raw PCM buffers (24kHz mono s16le) for voice transmission

**Outbound (bot → browser):**
- Binary: 4-byte user ID hash + PCM chunk (voice)
- JSON: `{ type: "user_state", users: [...] }` (active speakers)
- JSON: `{ type: "message_created", data: {...} }` (new text message)
- JSON: `{ type: "message_updated", data: {...} }` (edited message)
- JSON: `{ type: "message_deleted", data: {...} }` (deleted message)
- JSON: `{ type: "attachment_uploaded", data: {...} }` (image uploaded)

### Graceful Shutdown

Handles SIGINT/SIGTERM/uncaughtException/unhandledRejection:
1. Stop voice connection
2. Pause player
3. Destroy Discord client
4. Exit process

## Dashboard Usage

**Access:** `http://localhost:3000/dashboard.html`

**Features:**
- Three tabs: Text Messages | Images | Voice
- Channel/thread filter dropdown
- Real-time WebSocket updates
- Polling fallback if WebSocket disconnects
- Message display with metadata (author, timestamp, edits, deletions)
- Image grid with previews and upload status
- Voice segment list (future enhancement)

**Keyboard/UI:**
- Click tab to switch content type
- Select channel to filter
- Click image to view full size
- WebSocket status indicator (green = connected)

## Common Tasks

### Add a new config variable

1. Add to `configSchema` in `src/config.ts` with Zod validation
2. Add to `.env.example` with description
3. Use via `config.VARIABLE_NAME`

### Add a new REST endpoint

1. Add route in `src/webserver.ts` (Express)
2. Use database functions from `src/moderation/messageStore.ts`
3. Wrap in try-catch, pass errors to Express error handler
4. Return JSON response

### Add a new WebSocket event

1. Define broadcast function in `src/webserver.ts` (attach to globalThis)
2. Call from event handler (e.g., messageCapture.ts)
3. Send JSON with `{ type, data, timestamp }`
4. Handle in dashboard JavaScript

### Debug message capture

- Set `VERBOSE=true` in `.env` for detailed logging
- Check `/health` endpoint for active users/connections
- Monitor `/metrics` endpoint (Prometheus format)
- Check `recordings/<user-id>/` for voice segments
- Query SQLite directly: `sqlite3 .muxer-queue.db "SELECT * FROM messages LIMIT 10;"`

### Debug attachment uploads

- Check `upload_status` in attachments table
- View `upload_error` field for failure reasons
- Monitor logs for "Attachment upload" messages
- Verify picser endpoint is accessible
- Check file size against ATTACHMENT_MAX_SIZE_MB

## Dependencies

**Core:**
- **discord.js-selfbot-v13** — Discord client (selfbot variant)
- **@discordjs/voice** — Voice connection management
- **@discordjs/opus** — Native Opus codec (optional, required for web PCM)
- **prism-media** — Audio encoding/decoding (Opus, OGG)

**Web:**
- **express** — HTTP server
- **ws** — WebSocket server
- **helmet** — Security headers

**Data:**
- **better-sqlite3** — SQLite database
- **zod** — Config validation

**Logging & Monitoring:**
- **pino** — Structured logging
- **pino-http** — HTTP request logging
- **prom-client** — Prometheus metrics

**Utilities:**
- **p-retry** — Retry logic with backoff
- **class-transformer** — Object transformation
- **class-validator** — Data validation

**Dev:**
- **Biome** — Linting/formatting
- **Vitest** — Testing framework
- **TypeScript** — Type checking

## Notes

- Bot uses selfbot variant (user account) rather than standard bot token — check Discord ToS
- Opus decoding requires native `@discordjs/opus` under Node.js
- OGG segments include metadata JSON for each segment (user info, timestamps, duration)
- WebSocket broadcasts PCM in real-time; browser can transmit audio back to Discord
- Graceful shutdown ensures clean disconnection and resource cleanup
- All database operations use prepared statements to prevent SQL injection
- Attachment uploads are non-blocking (async) to avoid blocking message capture
- Message capture continues even if attachment upload fails
- Dashboard uses textContent for XSS prevention (not innerHTML)

## Future Enhancements

- Reaction tracking
- Message search/full-text search
- Moderation actions (flag, delete, mute)
- Export/archive functionality
- Retention policies (auto-delete old data)
- Voice segment metadata in dashboard
- User activity analytics
- Audit log export


## Architecture

### High-Level Flow

1. **Bot Entry** (`src/index.ts`) — Initializes Discord client, sets up graceful shutdown, starts webserver
2. **Voice Controller** (`src/voiceController.ts`) — Manages guild/channel selection and connection lifecycle
3. **Recorder** (`src/recorder.ts`) — Joins voice channel, subscribes to user audio streams, handles Opus decoding and segment rotation
4. **Web Server** (`src/webserver.ts`) — Express + WebSocket server for:
   - REST API: guild/channel listing, connect/disconnect
   - WebSocket: real-time PCM broadcast to browser, browser-to-Discord audio transmission
5. **Muxer Queue** (`src/muxer-queue.ts`) — SQLite-backed job queue for post-processing audio segments (future use)

### Key Modules

- **Recorder subsystem** (`src/recorder/`):
  - `audioStream.ts` — Subscribes to Discord audio receiver, emits Opus packets
  - `decoder.ts` — Opus decoder with runtime checks, cooldown/rotation logic for web PCM broadcast
  - `segment.ts` — Manages OGG file rotation (5s default segments per user)
  - `metadata.ts` — Collects user/role info, creates segment metadata JSON

- **Voice Connection** — Uses `@discordjs/voice` receiver to subscribe to speaking users; each user gets their own stream
- **Audio Pipeline**:
  - Discord → Opus packets → PacketFilter → OGG segments (disk) + OpusDecoder → PCM (web broadcast)
  - Browser → 24kHz mono PCM → upsample to 48kHz stereo → Opus encoder → OGG → Discord player

- **Metrics** (`src/metrics.ts`) — Prometheus metrics for audio levels, recordings, connections, WebSocket clients
- **Logging** (`src/logger.ts`) — Pino logger with pretty-print in dev, JSON in prod
- **Config** (`src/config.ts`) — Zod-validated environment variables with sensible defaults
- **Error Handling** (`src/errors.ts`) — Custom error classes (AppError, ConfigError, AudioError, VoiceConnectionError, ValidationError)

### Recording Structure

```
recordings/
  ├── <user-id>/
  │   ├── <user-id>-<session-start>-0.ogg
  │   ├── <user-id>-<session-start>-0.json
  │   ├── <user-id>-<session-start>-1.ogg
  │   ├── <user-id>-<session-start>-1.json
  │   └── ...
```

Each segment is 5s (configurable). Metadata JSON includes user info, roles, timestamps, duration.

### Database

- **Muxer Queue** (`.muxer-queue.db`) — SQLite with WAL mode, tracks pending/processing/completed/failed jobs for audio post-processing

## Development Commands

```bash
# Install dependencies
pnpm install

# Development (auto-restart on file changes)
pnpm run dev

# Production
pnpm run start

# Type checking
pnpm run typecheck

# Linting (Biome)
pnpm run lint

# Format code (Biome)
pnpm run format

# Run tests
pnpm run test

# Build TypeScript
pnpm run build
```

## Configuration

All config via `.env` (see `.env.example`). Key variables:

- `DISCORD_TOKEN` — Bot token (required)
- `RECORDINGS_DIR` — Where to save audio files (default: `./recordings`)
- `RECORDING_SEGMENT_MS` — OGG segment duration (default: 5000ms)
- `DECODER_ROTATE_MS` — Opus decoder rotation interval (default: 5000ms)
- `DECODER_COOLDOWN_MS` — Cooldown after decoder error (default: 30000ms)
- `WEBSERVER_PORT` — HTTP/WebSocket port (default: 3000)
- `VOICE_CONNECTION_TIMEOUT_MS` — Voice join timeout (default: 15000ms)
- `AUDIO_STREAM_SILENCE_DURATION_MS` — Silence threshold before ending stream (default: 3000ms)
- `LOG_LEVEL` — Pino log level (default: info)
- `VERBOSE` — Enable debug logging (default: false)

## Testing

Tests use **Vitest** in `tests/` directory. Run with `pnpm run test`.

Example: `tests/decoder.test.ts` tests Opus decoder runtime detection and native opus availability.

## Code Style

- **Formatter**: Biome (2-space indent)
- **Linter**: Biome with custom rules (warn on non-null assertions, noExplicitAny)
- **Language**: TypeScript with strict mode
- **Logging**: Use `createChildLogger(context)` for scoped logs
- **Errors**: Throw custom AppError subclasses with code + statusCode

## Key Patterns

### Voice Connection Lifecycle

1. `VoiceController.connect(guildId, channelId)` → calls `startRecording()`
2. `startRecording()` joins channel, sets up receiver, subscribes to speaking users
3. On user speak: create stream, segment manager, decoder; pipe to OGG + web broadcast
4. On silence (3s): close stream, save metadata JSON
5. `VoiceController.disconnect()` → calls `stopRecording()` → destroys connection

### Audio Decoding (Web Broadcast)

- OpusDecoder wraps prism decoder with error recovery
- Rotates decoder every 5s to prevent memory leaks
- Cools down for 30s after error before retrying
- Downsamples 48kHz stereo → 24kHz mono for web transmission

### WebSocket Protocol

- **Inbound** (browser → bot): Raw PCM buffers (24kHz mono s16le)
- **Outbound** (bot → browser): 
  - Binary: 4-byte user ID hash + PCM chunk
  - JSON: `{ type: "user_state", users: [...] }` on connect/user activity change

### Graceful Shutdown

Handles SIGINT/SIGTERM/uncaughtException/unhandledRejection:
1. Stop voice connection
2. Pause player
3. Destroy Discord client
4. Exit process

## Future Expansion (Text/Image Monitoring)

Current scope: voice only. Planned additions:
- Text channel message capture
- Image/attachment logging
- Per-channel/per-user filtering
- Moderation action triggers

These will likely require:
- Additional event listeners in recorder
- Extended metadata schema
- New storage/indexing strategy
- Webhook/alert system

## Common Tasks

### Add a new config variable

1. Add to `configSchema` in `src/config.ts` with Zod validation
2. Add to `.env.example`
3. Use via `config.VARIABLE_NAME`

### Add a new REST endpoint

1. Add route in `src/webserver.ts` (Express)
2. Use `VoiceController` methods or create new ones
3. Wrap in try-catch, pass errors to Express error handler

### Add metrics

1. Define gauge/counter/histogram in `src/metrics.ts`
2. Update in relevant code paths
3. Metrics exposed at `/metrics` endpoint (Prometheus format)

### Debug audio issues

- Set `VERBOSE=true` in `.env` for detailed logging
- Check `/health` endpoint for active users/connections
- Monitor audio levels via `/metrics` (audio_level_db gauge)
- Check segment files in `recordings/<user-id>/` directory

## Dependencies

- **discord.js-selfbot-v13** — Discord client (selfbot variant for user account access)
- **@discordjs/voice** — Voice connection management
- **@discordjs/opus** — Native Opus codec (optional, required for web PCM decode)
- **prism-media** — Audio encoding/decoding (Opus, OGG)
- **express** — HTTP server
- **ws** — WebSocket server
- **better-sqlite3** — SQLite database (muxer queue)
- **pino** — Structured logging
- **prom-client** — Prometheus metrics
- **zod** — Config validation
- **Biome** — Linting/formatting
- **Vitest** — Testing framework

## Notes

- Bot uses selfbot variant (user account) rather than standard bot token — check Discord ToS
- Opus decoding requires native `@discordjs/opus` under Node.js
- OGG segments include metadata JSON for each segment (user info, timestamps, duration)
- WebSocket broadcasts PCM in real-time; browser can transmit audio back to Discord
- Graceful shutdown ensures clean disconnection and resource cleanup

## CodeGraph Usage (Required)

- Use CodeGraph first for repo-level questions: architecture, dependencies, references, callers/callees, impact, flow, routes, components.
- If graph is missing or stale, run scan first to refresh `.codegraph/graph.json`.
- Prefer graph-backed flow:
  1. scan-codegraph (build/refresh graph)
  2. query-codegraph (find definitions/references/callers/dependencies)
  3. analyze-codegraph (architecture, impact, risk, cycles, orphans, hotspots)
  4. export-codegraph (json/mermaid/dot/markdown/html when needed)
  5. open-codegraph-ui (interactive visualization when requested)
- Avoid broad grep/find or repeated wide file reads before graph lookup, except for exact literal search or known single-file edits.
