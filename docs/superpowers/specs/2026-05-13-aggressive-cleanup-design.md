# Aggressive Codebase Cleanup Design

**Date:** 2026-05-13  
**Scope:** Biome setup + modularization + unit tests  
**Goal:** Production-ready code with strict typing, testability, and maintainability

---

## Overview

Transform the codebase from a monolithic, loosely-typed structure into modular, well-tested, and strictly-typed components. This involves:

1. **Tooling:** Add Biome (linter + formatter) and Vitest (test runner)
2. **Modularization:** Break `recorder.ts` into focused modules (`audioStream`, `decoder`, `segment`, `metadata`)
3. **Typing:** Eliminate all `any` types, use strict interfaces
4. **Testing:** Add unit tests for core logic (decoder rotation, segment management, metadata)
5. **Scripts:** Add `typecheck`, `lint`, `format`, `test` npm scripts

---

## Architecture

### Current State
- `src/recorder.ts` (345 lines): monolithic, handles audio stream, decoder, segment rotation, metadata
- `src/index.ts`: entry point, minimal error handling
- `src/config.ts`, `src/webserver.ts`, `src/player.ts`, etc.: loosely coupled via globals
- No linting, formatting, or tests

### Target State

```
src/
├── index.ts                    # Entry point (unchanged)
├── config.ts                   # Config + env validation (enhanced)
├── types.ts                    # Shared types (new)
├── recorder/
│   ├── index.ts               # Main recording orchestrator
│   ├── audioStream.ts         # Audio stream subscription & lifecycle
│   ├── decoder.ts             # Opus decoder with rotation & error handling
│   ├── segment.ts             # Segment lifecycle (open, close, rotate)
│   ├── metadata.ts            # Event metadata collection & serialization
│   └── packetFilter.ts        # (move from root)
├── webserver.ts               # (unchanged)
├── player.ts                  # (unchanged)
├── mock-crc.ts                # (unchanged)
├── muxer.ts                   # (unchanged)
├── muxer-aup3.ts              # (unchanged)
└── packetFilter.ts            # (unchanged)

tests/
├── recorder/
│   ├── decoder.test.ts        # Decoder rotation, error recovery
│   ├── segment.test.ts        # Segment open/close/rotate logic
│   └── metadata.test.ts       # Metadata collection & serialization
└── config.test.ts             # Env validation
```

---

## Components

### 1. **types.ts** (new)
Centralized type definitions for recorder subsystem.

```typescript
export interface UserMetadata {
  userId: string;
  username: string;
  tag: string;
  displayName: string;
  avatarUrl: string;
  bot: boolean;
  roles: Array<{ id: string; name: string; position: number }>;
  highestRole: { id: string; name: string; position: number } | null;
  joinedTimestamp: number | null;
}

export interface SegmentMetadata {
  userId: string;
  username: string;
  sessionId: string;
  sessionStartTime: number;
  segmentIndex: number;
  startTime: number;
  endTime: number;
  durationMs: number;
  filename: string;
  // ... other fields
}

export interface DecoderConfig {
  frameSize: number;
  channels: number;
  rate: number;
}

export interface SegmentState {
  index: number;
  startTime: number;
  endTime: number | null;
  filename: string;
  jsonFilename: string;
  oggStream: any; // prism.opus.OggLogicalBitstream
  out: fs.WriteStream;
}
```

### 2. **config.ts** (enhanced)
Strict env validation with typed config object.

```typescript
export interface Config {
  verbose: boolean;
  recordingsDir: string;
  recordingSegmentMs: number;
  decoderRotateMs: number;
  decoderCooldownMs: number;
}

export function loadConfig(): Config {
  const recordingSegmentMsRaw = Number(process.env.RECORDING_SEGMENT_MS ?? 5_000);
  const recordingSegmentMs = Number.isFinite(recordingSegmentMsRaw) && recordingSegmentMsRaw > 0
    ? recordingSegmentMsRaw
    : 0;

  return {
    verbose: process.env.VERBOSE === 'true',
    recordingsDir: process.env.RECORDINGS_DIR ?? './recordings',
    recordingSegmentMs,
    decoderRotateMs: Number(process.env.DECODER_ROTATE_MS ?? 5_000),
    decoderCooldownMs: 30_000,
  };
}

export const config = loadConfig();
```

### 3. **recorder/decoder.ts** (new)
Isolated decoder lifecycle with rotation and error recovery.

```typescript
export class OpusDecoder {
  private decoder: prism.opus.Decoder | null = null;
  private disabledUntil = 0;
  private createdAt = 0;
  private readonly config: DecoderConfig;
  private readonly cooldownMs: number;
  private readonly rotateMs: number;
  private onData: (pcm: Buffer) => void;

  constructor(config: DecoderConfig, cooldownMs: number, rotateMs: number, onData: (pcm: Buffer) => void) {
    this.config = config;
    this.cooldownMs = cooldownMs;
    this.rotateMs = rotateMs;
    this.onData = onData;
  }

  create(): prism.opus.Decoder | null {
    if (Date.now() < this.disabledUntil) return null;
    try {
      const d = new prism.opus.Decoder(this.config);
      d.on('data', this.onData);
      d.on('error', () => this.handleError());
      this.createdAt = Date.now();
      return d;
    } catch (err) {
      console.warn('[decoder] Init failed, cooling down:', err);
      this.disabledUntil = Date.now() + this.cooldownMs;
      return null;
    }
  }

  rotateIfNeeded(): void {
    if (!this.decoder || this.rotateMs <= 0) return;
    if (Date.now() - this.createdAt < this.rotateMs) return;
    this.destroy();
    this.decoder = this.create();
  }

  write(chunk: Buffer): void {
    if (!this.decoder) return;
    try {
      this.decoder.write(chunk);
    } catch (err) {
      console.warn('[decoder] Write failed, cooling down:', err);
      this.handleError();
    }
  }

  private handleError(): void {
    this.disabledUntil = Date.now() + this.cooldownMs;
    this.destroy();
  }

  destroy(): void {
    if (!this.decoder) return;
    this.decoder.removeAllListeners();
    this.decoder.destroy();
    this.decoder = null;
    this.createdAt = 0;
  }
}
```

### 4. **recorder/segment.ts** (new)
Segment lifecycle management (open, close, rotate).

```typescript
export class SegmentManager {
  private currentSegment: SegmentState | null = null;
  private segmentIndex = 0;
  private readonly recordingSegmentMs: number;
  private readonly userDir: string;
  private readonly userId: string;
  private readonly sessionId: string;
  private readonly sessionStartTime: number;

  constructor(userId: string, userDir: string, sessionId: string, sessionStartTime: number, recordingSegmentMs: number) {
    this.userId = userId;
    this.userDir = userDir;
    this.sessionId = sessionId;
    this.sessionStartTime = sessionStartTime;
    this.recordingSegmentMs = recordingSegmentMs;
  }

  open(oggPacketStream: NodeJS.ReadableStream): SegmentState {
    const index = this.segmentIndex++;
    const startTime = Date.now();
    const segmentFilename = path.join(this.userDir, `${startTime}.ogg`);
    const segmentJsonFilename = path.join(this.userDir, `${startTime}.json`);
    const oggStream = new prism.opus.OggLogicalBitstream({
      opusHead: new prism.opus.OpusHead({ channelCount: 2, sampleRate: 48000 }),
      pageSizeControl: { maxPackets: 10 },
      crc: true,
    });
    const out = fs.createWriteStream(segmentFilename);
    oggPacketStream.pipe(oggStream).pipe(out);

    const segment: SegmentState = {
      index,
      startTime,
      endTime: null,
      filename: segmentFilename,
      jsonFilename: segmentJsonFilename,
      oggStream,
      out,
    };

    this.currentSegment = segment;
    return segment;
  }

  close(): void {
    if (!this.currentSegment) return;
    this.currentSegment.endTime = Date.now();
    this.currentSegment.oggStream.end();
    this.currentSegment = null;
  }

  rotateIfNeeded(oggPacketStream: NodeJS.ReadableStream): void {
    if (!this.currentSegment || this.recordingSegmentMs <= 0) return;
    if (Date.now() - this.currentSegment.startTime < this.recordingSegmentMs) return;
    this.close();
    this.open(oggPacketStream);
  }

  getCurrent(): SegmentState | null {
    return this.currentSegment;
  }
}
```

### 5. **recorder/metadata.ts** (new)
User and event metadata collection.

```typescript
export async function collectUserMetadata(
  client: Client,
  userId: string,
  channel: VoiceChannel
): Promise<UserMetadata> {
  const user = client.users.cache.get(userId) || await client.users.fetch(userId).catch(() => null);
  const member = channel.guild.members.cache.get(userId) || await channel.guild.members.fetch(userId).catch(() => null);

  const username = user?.username ?? 'Unknown User';
  const avatarUrl = user?.displayAvatarURL({ format: 'png', size: 64 }) ?? 'https://cdn.discordapp.com/embed/avatars/0.png';
  const displayName = member?.displayName ?? username;
  const roles = (member?.roles.cache
    .filter((role) => role.id !== channel.guild.id)
    .sort((a, b) => b.position - a.position)
    .map((role) => ({ id: role.id, name: role.name, position: role.position })) ?? []) as Array<{ id: string; name: string; position: number }>;
  const highestRole = roles.length > 0 ? roles[0] : null;
  const joinedTimestamp = member?.joinedTimestamp ?? null;

  return {
    userId,
    username,
    tag: user?.tag ?? 'Unknown#0000',
    displayName,
    avatarUrl,
    bot: user?.bot ?? false,
    roles,
    highestRole,
    joinedTimestamp,
  };
}

export function createSegmentMetadata(
  userMetadata: UserMetadata,
  segment: SegmentState,
  sessionId: string,
  sessionStartTime: number,
  recordingSegmentMs: number
): SegmentMetadata {
  const endTime = segment.endTime ?? Date.now();
  return {
    userId: userMetadata.userId,
    username: userMetadata.username,
    tag: userMetadata.tag,
    displayName: userMetadata.displayName,
    avatarUrl: userMetadata.avatarUrl,
    bot: userMetadata.bot,
    roles: userMetadata.roles,
    highestRole: userMetadata.highestRole,
    joinedTimestamp: userMetadata.joinedTimestamp,
    sessionId,
    sessionStartTime,
    segmentIndex: segment.index,
    segmentMs: recordingSegmentMs,
    startTime: segment.startTime,
    endTime,
    durationMs: endTime - segment.startTime,
    filename: path.basename(segment.filename),
  };
}
```

### 6. **recorder/audioStream.ts** (new)
Audio stream subscription and packet handling.

```typescript
export async function subscribeToAudioStream(
  receiver: VoiceReceiver,
  userId: string,
  onPacket: (chunk: Buffer) => void,
  onEnd: () => void,
  onError: (err: Error) => void
): Promise<NodeJS.ReadableStream> {
  const audioStream = receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: 3000,
    },
  });

  audioStream.on('data', onPacket);
  audioStream.on('end', onEnd);
  audioStream.on('error', onError);

  return audioStream;
}
```

### 7. **recorder/index.ts** (new)
Main orchestrator, replaces current `recorder.ts`.

Coordinates audio stream, decoder, segment, and metadata. Cleaner, testable logic.

---

## Testing Strategy

### Unit Tests (Vitest)

**decoder.test.ts:**
- Decoder creation succeeds with valid config
- Decoder enters cooldown on error
- Decoder rotates after timeout
- Write fails gracefully during cooldown

**segment.test.ts:**
- Segment opens with correct filename
- Segment closes and sets endTime
- Segment rotates when duration exceeded
- Multiple segments tracked correctly

**metadata.test.ts:**
- User metadata collected correctly
- Segment metadata serialized to JSON
- Missing user data handled gracefully

**config.test.ts:**
- Env vars parsed correctly
- Invalid values default safely
- Numeric validation works

### Integration Tests (manual for now)
- Full recording flow: join → speak → record → disconnect
- Decoder error recovery doesn't crash process
- Segment rotation produces correct files

---

## Implementation Order

1. **Setup tooling:** Biome + Vitest + npm scripts
2. **Create types.ts** — shared interfaces
3. **Enhance config.ts** — strict validation
4. **Extract decoder.ts** — isolated, testable
5. **Extract segment.ts** — lifecycle management
6. **Extract metadata.ts** — data collection
7. **Extract audioStream.ts** — stream handling
8. **Rewrite recorder/index.ts** — orchestrator
9. **Write unit tests** — all modules
10. **Update index.ts** — use new recorder module
11. **Remove old recorder.ts**
12. **Verify behavior** — manual test

---

## Success Criteria

- ✅ No `any` types (except necessary prism/discord.js types)
- ✅ All modules < 150 lines
- ✅ Unit tests pass (decoder, segment, metadata, config)
- ✅ Biome lint + format passes
- ✅ Recording behavior identical to before
- ✅ npm scripts: `typecheck`, `lint`, `format`, `test`
- ✅ All files committed with clear messages

---

## Trade-offs

- **More files:** Easier to understand and test, but more to navigate
- **Setup time:** Biome + Vitest + tests add ~2-3 hours, but pay off in maintainability
- **Behavior:** Identical to current; no feature changes
