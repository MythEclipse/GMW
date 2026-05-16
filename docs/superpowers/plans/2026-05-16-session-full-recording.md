# Session Full Recording Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build background full-session OGG recording generation from voice join to leave while preserving existing per-user segment recordings.

**Architecture:** Add a focused session tracker that records session timing, participants, and per-user segment references. Add a session muxer that builds timeline-offset ffmpeg filters and writes `recordings/sessions/<sessionId>/session.json` plus `full.ogg`. Wire recorder lifecycle to create a session on join, register finished human segments, and finalize in the background on stop/destroy.

**Tech Stack:** TypeScript, Vitest, Node fs/path, ffmpeg via existing `buildMuxFfmpegArgs` and `runFfmpeg`, Discord voice receiver pipeline.

---

## File Structure

- Create `src/recorder/sessionRecording.ts`: session metadata types, session tracker, mux filter builder, and session finalization function.
- Modify `src/types.ts`: add `recordingSessionId` to per-user `SegmentMetadata`.
- Modify `src/recorder/metadata.ts`: accept and write shared `recordingSessionId` into segment metadata.
- Modify `src/recorder.ts`: create session on ready, skip bots as now, register segment metadata, finalize session in background on stop/destroy.
- Create `tests/recorder/sessionRecording.test.ts`: unit tests for session tracker, mux filter, empty session, and failed mux metadata.
- Modify `tests/recorder.test.ts`: assert bot/self users do not register session participants or subscriptions; add stop finalization trigger test with injected session finalizer if needed.

---

### Task 1: Session Recording Metadata and Mux Builder

**Files:**
- Create: `src/recorder/sessionRecording.ts`
- Test: `tests/recorder/sessionRecording.test.ts`

- [ ] **Step 1: Write failing tests for session tracker and mux filter**

Create `tests/recorder/sessionRecording.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  buildSessionMuxFilter,
  createRecordingSession,
  finalizeRecordingSession,
} from "../../src/recorder/sessionRecording";
import type { UserMetadata } from "../../src/types";

function user(overrides: Partial<UserMetadata> = {}): UserMetadata {
  return {
    userId: "user-1",
    username: "Alice",
    tag: "Alice#0001",
    displayName: "Alice",
    avatarUrl: "https://example.com/avatar.png",
    bot: false,
    roles: [],
    highestRole: null,
    joinedTimestamp: null,
    ...overrides,
  };
}

describe("sessionRecording", () => {
  it("tracks participants and segment refs", () => {
    const session = createRecordingSession({
      guildId: "guild",
      channelId: "voice",
      channelName: "Voice",
      startTime: 1000,
      recordingsDir: "/recordings",
    });

    session.registerSegment({
      user: user(),
      oggPath: "/recordings/user-1/1500.ogg",
      jsonPath: "/recordings/user-1/1500.json",
      startTime: 1500,
      endTime: 2500,
    });

    const snapshot = session.snapshot(3000);

    expect(snapshot).toMatchObject({
      sessionId: "guild-voice-1000",
      guildId: "guild",
      channelId: "voice",
      channelName: "Voice",
      startTime: 1000,
      endTime: 3000,
      durationMs: 2000,
      status: "pending",
      participants: [{ userId: "user-1", username: "Alice" }],
      segments: [
        {
          userId: "user-1",
          oggPath: "/recordings/user-1/1500.ogg",
          jsonPath: "/recordings/user-1/1500.json",
          startTime: 1500,
          endTime: 2500,
          offsetMs: 500,
        },
      ],
    });
  });

  it("builds timeline-offset ffmpeg filter", () => {
    const filter = buildSessionMuxFilter([
      { startTime: 1000 },
      { startTime: 2500 },
    ], 1000);

    expect(filter).toBe(
      "[0:a]adelay=0|0[pad0];[1:a]adelay=1500|1500[pad1];[pad0][pad1]amix=inputs=2:dropout_transition=0[out]",
    );
  });

  it("writes empty metadata without running ffmpeg", async () => {
    const session = createRecordingSession({
      guildId: "guild",
      channelId: "voice",
      channelName: "Voice",
      startTime: 1000,
      recordingsDir: "/recordings",
    });
    const writeJson = vi.fn();
    const mkdir = vi.fn();
    const runFfmpeg = vi.fn();

    await finalizeRecordingSession(session, {
      endTime: 4000,
      mkdir,
      writeJson,
      runFfmpeg,
    });

    expect(runFfmpeg).not.toHaveBeenCalled();
    expect(mkdir).toHaveBeenCalledWith("/recordings/sessions/guild-voice-1000");
    expect(writeJson).toHaveBeenCalledWith(
      "/recordings/sessions/guild-voice-1000/session.json",
      expect.objectContaining({ status: "empty", durationMs: 3000 }),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm exec vitest run tests/recorder/sessionRecording.test.ts
```

Expected: FAIL because `src/recorder/sessionRecording.ts` does not exist.

- [ ] **Step 3: Implement session tracker and mux filter**

Create `src/recorder/sessionRecording.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import { buildMuxFfmpegArgs, runFfmpeg as defaultRunFfmpeg } from "../audio/ffmpegProcess";
import type { UserMetadata } from "../types";

export type SessionRecordingStatus = "pending" | "completed" | "failed" | "empty";

export interface RecordingSessionOptions {
  guildId: string;
  channelId: string;
  channelName: string;
  startTime: number;
  recordingsDir: string;
}

export interface SessionSegmentInput {
  user: UserMetadata;
  oggPath: string;
  jsonPath: string;
  startTime: number;
  endTime: number;
}

export interface SessionParticipant {
  userId: string;
  username: string;
  tag: string;
  displayName: string;
  avatarUrl: string;
}

export interface SessionSegmentRef {
  userId: string;
  oggPath: string;
  jsonPath: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  offsetMs: number;
}

export interface SessionRecordingMetadata {
  sessionId: string;
  guildId: string;
  channelId: string;
  channelName: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  status: SessionRecordingStatus;
  outputFile: string | null;
  participants: SessionParticipant[];
  segments: SessionSegmentRef[];
  error?: string;
}

export interface RecordingSession {
  readonly sessionId: string;
  readonly recordingsDir: string;
  readonly startTime: number;
  registerSegment(input: SessionSegmentInput): void;
  snapshot(endTime: number): SessionRecordingMetadata;
}

export interface FinalizeRecordingSessionDependencies {
  endTime?: number;
  mkdir?: (dir: string) => void;
  writeJson?: (file: string, metadata: SessionRecordingMetadata) => void;
  runFfmpeg?: (args: string[]) => Promise<void>;
}

export function createRecordingSession(options: RecordingSessionOptions): RecordingSession {
  const sessionId = `${options.guildId}-${options.channelId}-${options.startTime}`;
  const participants = new Map<string, SessionParticipant>();
  const segments: SessionSegmentRef[] = [];

  return {
    sessionId,
    recordingsDir: options.recordingsDir,
    startTime: options.startTime,

    registerSegment(input: SessionSegmentInput): void {
      participants.set(input.user.userId, {
        userId: input.user.userId,
        username: input.user.username,
        tag: input.user.tag,
        displayName: input.user.displayName,
        avatarUrl: input.user.avatarUrl,
      });
      segments.push({
        userId: input.user.userId,
        oggPath: input.oggPath,
        jsonPath: input.jsonPath,
        startTime: input.startTime,
        endTime: input.endTime,
        durationMs: input.endTime - input.startTime,
        offsetMs: input.startTime - options.startTime,
      });
    },

    snapshot(endTime: number): SessionRecordingMetadata {
      return {
        sessionId,
        guildId: options.guildId,
        channelId: options.channelId,
        channelName: options.channelName,
        startTime: options.startTime,
        endTime,
        durationMs: endTime - options.startTime,
        status: "pending",
        outputFile: null,
        participants: Array.from(participants.values()),
        segments: [...segments],
      };
    },
  };
}

export function buildSessionMuxFilter(
  segments: Array<{ startTime: number }>,
  sessionStartTime: number,
): string {
  const filters = segments.map((segment, index) => {
    const delayMs = Math.max(0, segment.startTime - sessionStartTime);
    return `[${index}:a]adelay=${delayMs}|${delayMs}[pad${index}]`;
  });
  const inputs = segments.map((_, index) => `[pad${index}]`).join("");
  filters.push(`${inputs}amix=inputs=${segments.length}:dropout_transition=0[out]`);
  return filters.join(";");
}

export async function finalizeRecordingSession(
  session: RecordingSession,
  dependencies: FinalizeRecordingSessionDependencies = {},
): Promise<void> {
  const endTime = dependencies.endTime ?? Date.now();
  const sessionDir = path.join(session.recordingsDir, "sessions", session.sessionId);
  const outputFile = path.join(sessionDir, "full.ogg");
  const metadataFile = path.join(sessionDir, "session.json");
  const mkdir = dependencies.mkdir ?? ((dir) => fs.mkdirSync(dir, { recursive: true }));
  const writeJson =
    dependencies.writeJson ??
    ((file, metadata) => fs.writeFileSync(file, JSON.stringify(metadata, null, 2)));
  const runFfmpeg = dependencies.runFfmpeg ?? defaultRunFfmpeg;

  mkdir(sessionDir);
  const metadata = session.snapshot(endTime);

  if (metadata.segments.length === 0) {
    writeJson(metadataFile, { ...metadata, status: "empty" });
    return;
  }

  try {
    await runFfmpeg(
      buildMuxFfmpegArgs({
        inputs: metadata.segments.map((segment) => segment.oggPath),
        filter: buildSessionMuxFilter(metadata.segments, metadata.startTime),
        output: outputFile,
        codec: "libopus",
      }),
    );
    writeJson(metadataFile, {
      ...metadata,
      status: "completed",
      outputFile,
    });
  } catch (error) {
    writeJson(metadataFile, {
      ...metadata,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm exec vitest run tests/recorder/sessionRecording.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

Run:

```bash
git add src/recorder/sessionRecording.ts tests/recorder/sessionRecording.test.ts
git commit -m "feat: add recording session metadata"
```

---

### Task 2: Add Shared Recording Session ID to Segment Metadata

**Files:**
- Modify: `src/types.ts`
- Modify: `src/recorder/metadata.ts`
- Test: `tests/recorder/metadata.test.ts`

- [ ] **Step 1: Write failing metadata test**

Create `tests/recorder/metadata.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createSegmentMetadata } from "../../src/recorder/metadata";
import type { SegmentState, UserMetadata } from "../../src/types";

const user: UserMetadata = {
  userId: "user-1",
  username: "Alice",
  tag: "Alice#0001",
  displayName: "Alice",
  avatarUrl: "https://example.com/avatar.png",
  bot: false,
  roles: [],
  highestRole: null,
  joinedTimestamp: null,
};

const segment = {
  index: 0,
  startTime: 1500,
  endTime: 2500,
  filename: "/recordings/user-1/1500.ogg",
  jsonFilename: "/recordings/user-1/1500.json",
} as SegmentState;

describe("createSegmentMetadata", () => {
  it("includes shared recording session id", () => {
    const metadata = createSegmentMetadata(
      user,
      segment,
      "user-1-1500",
      "guild-voice-1000",
      1000,
      5000,
    );

    expect(metadata).toMatchObject({
      sessionId: "user-1-1500",
      recordingSessionId: "guild-voice-1000",
      sessionStartTime: 1000,
      startTime: 1500,
      endTime: 2500,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm exec vitest run tests/recorder/metadata.test.ts
```

Expected: FAIL because `createSegmentMetadata` does not accept `recordingSessionId` yet.

- [ ] **Step 3: Update metadata type and function signature**

Modify `src/types.ts`:

```ts
export interface SegmentMetadata extends UserMetadata {
  sessionId: string;
  recordingSessionId: string;
  sessionStartTime: number;
  segmentIndex: number;
  segmentMs: number;
  startTime: number;
  endTime: number;
  durationMs: number;
  filename: string;
}
```

Modify `src/recorder/metadata.ts` function signature and return object:

```ts
export function createSegmentMetadata(
  user: UserMetadata,
  segment: SegmentState,
  sessionId: string,
  recordingSessionId: string,
  sessionStartTime: number,
  recordingSegmentMs: number,
): SegmentMetadata {
  const endTime = segment.endTime ?? Date.now();
  return {
    ...user,
    sessionId,
    recordingSessionId,
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

- [ ] **Step 4: Update existing call sites**

In `src/recorder.ts`, update the call to include `recordingSession.sessionId` after the per-user `sessionId` argument:

```ts
const metadata = createSegmentMetadata(
  userMetadata,
  currentSegment,
  sessionId,
  recordingSession.sessionId,
  sessionStartTime,
  config.RECORDING_SEGMENT_MS,
);
```

- [ ] **Step 5: Run metadata tests and typecheck**

Run:

```bash
pnpm exec vitest run tests/recorder/metadata.test.ts
pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

Run:

```bash
git add src/types.ts src/recorder/metadata.ts src/recorder.ts tests/recorder/metadata.test.ts
git commit -m "feat: tag segments with recording session"
```

---

### Task 3: Wire Session Tracking into Recorder Lifecycle

**Files:**
- Modify: `src/recorder.ts`
- Modify: `tests/recorder.test.ts`

- [ ] **Step 1: Write failing recorder lifecycle tests**

Append to `tests/recorder.test.ts`:

```ts
it("finalizes the active recording session when stopped", async () => {
  const { startRecording, stopRecording } = await import("../src/recorder");
  const { getVoiceConnection } = await import("@discordjs/voice");
  const destroy = vi.fn();
  vi.mocked(getVoiceConnection).mockReturnValue({ destroy } as never);

  await startRecording({ user: { id: "self-user" } } as never, createChannel() as never);
  stopRecording("guild");
  await new Promise((resolve) => setImmediate(resolve));

  expect(destroy).toHaveBeenCalled();
});
```

Then add a test that emits a non-bot user and asserts `subscribe` is called once, while existing self/bot tests still assert zero subscriptions.

- [ ] **Step 2: Run recorder tests to verify failure if session APIs are missing**

Run:

```bash
pnpm exec vitest run tests/recorder.test.ts
```

Expected: FAIL until recorder imports and uses session recording APIs.

- [ ] **Step 3: Add active session map and finalize helper**

Modify `src/recorder.ts` imports:

```ts
import {
  createRecordingSession,
  finalizeRecordingSession,
  type RecordingSession,
} from "./recorder/sessionRecording";
```

Add near `recordingsDir`:

```ts
const activeRecordingSessions = new Map<string, RecordingSession>();

function finalizeActiveRecordingSession(guildId: string): void {
  const session = activeRecordingSessions.get(guildId);
  if (!session) return;
  activeRecordingSessions.delete(guildId);
  finalizeRecordingSession(session).catch((error) => {
    logger.error({ error }, "Failed to finalize recording session");
  });
}
```

After connection reaches ready, create and store the session:

```ts
const recordingSession = createRecordingSession({
  guildId: channel.guild.id,
  channelId: channel.id,
  channelName: channel.name,
  startTime: Date.now(),
  recordingsDir,
});
activeRecordingSessions.set(channel.guild.id, recordingSession);
```

In segment finish handler, after writing per-user JSON, register the segment:

```ts
recordingSession.registerSegment({
  user: userMetadata,
  oggPath: currentSegment.filename,
  jsonPath: currentSegment.jsonFilename,
  startTime: currentSegment.startTime,
  endTime: metadata.endTime,
});
```

In `stopRecording(guildId)`, call `finalizeActiveRecordingSession(guildId)` before destroying connection.

In `connection.on(VoiceConnectionStatus.Destroyed, ...)`, call `finalizeActiveRecordingSession(channel.guild.id)`.

- [ ] **Step 4: Run recorder tests and typecheck**

Run:

```bash
pnpm exec vitest run tests/recorder.test.ts tests/recorder/sessionRecording.test.ts tests/recorder/metadata.test.ts
pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

Run:

```bash
git add src/recorder.ts tests/recorder.test.ts
git commit -m "feat: finalize recording sessions on disconnect"
```

---

### Task 4: Final Verification

**Files:**
- All changed recorder/session files.

- [ ] **Step 1: Run recorder-focused tests**

Run:

```bash
pnpm exec vitest run tests/recorder.test.ts tests/recorder/sessionRecording.test.ts tests/recorder/metadata.test.ts tests/audio/ffmpegProcess.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run:

```bash
pnpm run test
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```bash
pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run lint**

Run:

```bash
pnpm run lint
```

Expected: PASS.

- [ ] **Step 5: Check git status**

Run:

```bash
git status --short
```

Expected: only intentional implementation, spec, and plan changes are present.
```
