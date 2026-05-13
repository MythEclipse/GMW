# Aggressive Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clean up Bun/TypeScript Discord voice recorder with Biome, Vitest, stricter types, modular recorder code, and verification scripts.

**Architecture:** Keep runtime behavior same while moving pure logic into focused modules. `src/recorder.ts` remains public API or re-exports recorder module to minimize import churn; new `src/recorder/*` files own config parsing, metadata creation, decoder lifecycle, segment lifecycle, and stream orchestration.

**Tech Stack:** Bun, TypeScript strict mode, Biome, Vitest, discord.js-selfbot-v13, @discordjs/voice, prism-media.

---

## File Map

- Modify `package.json`: add scripts and dev dependencies.
- Create `biome.json`: formatter/linter config.
- Create `vitest.config.ts`: Bun-compatible Vitest config.
- Modify `tsconfig.json`: include tests/config if needed, keep strict mode.
- Modify `src/config.ts`: typed env/config parsing.
- Create `src/types.ts`: shared recorder-facing types.
- Create `src/recorder/metadata.ts`: user metadata and segment metadata builders.
- Create `src/recorder/decoder.ts`: Opus decoder lifecycle.
- Create `src/recorder/segment.ts`: OGG segment lifecycle.
- Create `src/recorder/audioStream.ts`: subscribe/event wiring helpers.
- Modify `src/recorder.ts`: orchestrator using new modules.
- Create `tests/config.test.ts`, `tests/recorder/metadata.test.ts`, `tests/recorder/decoder.test.ts`, `tests/recorder/segment.test.ts`.

---

### Task 1: Tooling setup

**Files:**
- Modify: `package.json`
- Create: `biome.json`
- Create: `vitest.config.ts`
- Modify: `tsconfig.json`

- [ ] **Step 1: Add dependencies**

Run:
```bash
bun add -d @biomejs/biome vitest
```
Expected: `package.json` and lockfile update.

- [ ] **Step 2: Update scripts in `package.json`**

Set scripts to include:
```json
{
  "dev": "bun --watch src/index.ts",
  "start": "bun src/index.ts",
  "typecheck": "tsc --noEmit",
  "lint": "biome check .",
  "format": "biome format --write .",
  "test": "vitest run"
}
```

- [ ] **Step 3: Create `biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "files": {
    "includes": ["src/**/*.ts", "tests/**/*.ts", "*.json", "*.ts"]
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": {
        "noExplicitAny": "warn"
      }
    }
  }
}
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 5: Verify tooling commands**

Run:
```bash
bun run typecheck
bun run lint
bun run test
```
Expected: typecheck may pass or show existing issues; lint may show format/type warnings; test may pass with no tests or fail if Vitest needs config adjustment. Fix only setup errors in this task.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lockb biome.json vitest.config.ts tsconfig.json
git commit -m "chore: add code quality tooling"
```

---

### Task 2: Config parsing tests and implementation

**Files:**
- Modify: `src/config.ts`
- Create: `tests/config.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/config.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { parseBoolean, parsePositiveNumber } from "../src/config";

describe("config parsers", () => {
  it("parses boolean values", () => {
    expect(parseBoolean("true", false)).toBe(true);
    expect(parseBoolean("false", true)).toBe(false);
    expect(parseBoolean(undefined, true)).toBe(true);
  });

  it("parses positive numbers", () => {
    expect(parsePositiveNumber("5000", 0)).toBe(5000);
    expect(parsePositiveNumber("0", 123)).toBe(123);
    expect(parsePositiveNumber("bad", 123)).toBe(123);
    expect(parsePositiveNumber(undefined, 123)).toBe(123);
  });
});
```

- [ ] **Step 2: Run failing test**

Run:
```bash
bun run test tests/config.test.ts
```
Expected: FAIL because `parseBoolean` and `parsePositiveNumber` are not exported.

- [ ] **Step 3: Implement config helpers**

Update `src/config.ts` to export:
```ts
export interface AppConfig {
  verbose: boolean;
  recordingsDir: string;
  recordingSegmentMs: number;
  decoderRotateMs: number;
  decoderCooldownMs: number;
}

export function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

export function parsePositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    verbose: parseBoolean(env.VERBOSE, false),
    recordingsDir: env.RECORDINGS_DIR ?? "./recordings",
    recordingSegmentMs: parsePositiveNumber(env.RECORDING_SEGMENT_MS, 5_000),
    decoderRotateMs: parsePositiveNumber(env.DECODER_ROTATE_MS, 5_000),
    decoderCooldownMs: 30_000,
  };
}

export const config = loadConfig();
```
Preserve any existing exports by folding them into `AppConfig` if needed.

- [ ] **Step 4: Run config tests**

Run:
```bash
bun run test tests/config.test.ts
```
Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run:
```bash
bun run typecheck
```
Expected: PASS or only unrelated existing errors. Fix config-related errors.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "refactor: type application config"
```

---

### Task 3: Shared recorder types

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Create shared types**

Create `src/types.ts`:
```ts
import type fs from "node:fs";
import type prism from "prism-media";

export interface RoleMetadata {
  id: string;
  name: string;
  position: number;
}

export interface UserMetadata {
  userId: string;
  username: string;
  tag: string;
  displayName: string;
  avatarUrl: string;
  bot: boolean;
  roles: RoleMetadata[];
  highestRole: RoleMetadata | null;
  joinedTimestamp: number | null;
}

export interface SegmentState {
  index: number;
  startTime: number;
  endTime: number | null;
  filename: string;
  jsonFilename: string;
  oggStream: prism.opus.OggLogicalBitstream;
  out: fs.WriteStream;
}

export interface SegmentMetadata extends UserMetadata {
  sessionId: string;
  sessionStartTime: number;
  segmentIndex: number;
  segmentMs: number;
  startTime: number;
  endTime: number;
  durationMs: number;
  filename: string;
}

export interface PcmBroadcaster {
  broadcastPcmToWeb?: (chunk: Buffer, userId: string) => void;
  updateActiveUser?: (userId: string, data: { username: string; avatar: string; speaking: boolean }) => void;
}
```

- [ ] **Step 2: Run typecheck**

Run:
```bash
bun run typecheck
```
Expected: PASS. If prism type export fails, use `unknown` for `oggStream` plus local narrowed calls in segment implementation.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "refactor: add recorder domain types"
```

---

### Task 4: Metadata tests and implementation

**Files:**
- Create: `src/recorder/metadata.ts`
- Create: `tests/recorder/metadata.test.ts`

- [ ] **Step 1: Write tests**

Create `tests/recorder/metadata.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createSegmentMetadata } from "../../src/recorder/metadata";
import type { SegmentState, UserMetadata } from "../../src/types";

const user: UserMetadata = {
  userId: "123",
  username: "alice",
  tag: "alice#0001",
  displayName: "Alice",
  avatarUrl: "https://cdn.discordapp.com/embed/avatars/0.png",
  bot: false,
  roles: [{ id: "role", name: "Admin", position: 1 }],
  highestRole: { id: "role", name: "Admin", position: 1 },
  joinedTimestamp: 100,
};

const segment = {
  index: 2,
  startTime: 1_000,
  endTime: 2_500,
  filename: "/tmp/2500.ogg",
  jsonFilename: "/tmp/2500.json",
  oggStream: {} as SegmentState["oggStream"],
  out: {} as SegmentState["out"],
};

describe("createSegmentMetadata", () => {
  it("combines user and segment data", () => {
    const metadata = createSegmentMetadata(user, segment, "session-1", 900, 5_000);

    expect(metadata).toMatchObject({
      userId: "123",
      username: "alice",
      sessionId: "session-1",
      sessionStartTime: 900,
      segmentIndex: 2,
      segmentMs: 5_000,
      startTime: 1_000,
      endTime: 2_500,
      durationMs: 1_500,
      filename: "2500.ogg",
    });
  });
});
```

- [ ] **Step 2: Run failing test**

```bash
bun run test tests/recorder/metadata.test.ts
```
Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement metadata module**

Create `src/recorder/metadata.ts`:
```ts
import path from "node:path";
import type { Client, VoiceChannel } from "discord.js-selfbot-v13";
import type { SegmentMetadata, SegmentState, UserMetadata } from "../types";

export async function collectUserMetadata(
  client: Client,
  userId: string,
  channel: VoiceChannel,
): Promise<UserMetadata> {
  const user = client.users.cache.get(userId) ?? (await client.users.fetch(userId).catch(() => null));
  const member = channel.guild.members.cache.get(userId) ?? (await channel.guild.members.fetch(userId).catch(() => null));
  const username = user?.username ?? "Unknown User";
  const roles =
    member?.roles.cache
      .filter((role) => role.id !== channel.guild.id)
      .sort((a, b) => b.position - a.position)
      .map((role) => ({ id: role.id, name: role.name, position: role.position })) ?? [];

  return {
    userId,
    username,
    tag: user?.tag ?? "Unknown#0000",
    displayName: member?.displayName ?? username,
    avatarUrl: user?.displayAvatarURL({ format: "png", size: 64 }) ?? "https://cdn.discordapp.com/embed/avatars/0.png",
    bot: user?.bot ?? false,
    roles,
    highestRole: roles[0] ?? null,
    joinedTimestamp: member?.joinedTimestamp ?? null,
  };
}

export function createSegmentMetadata(
  user: UserMetadata,
  segment: SegmentState,
  sessionId: string,
  sessionStartTime: number,
  recordingSegmentMs: number,
): SegmentMetadata {
  const endTime = segment.endTime ?? Date.now();
  return {
    ...user,
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

- [ ] **Step 4: Run tests and typecheck**

```bash
bun run test tests/recorder/metadata.test.ts
bun run typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/recorder/metadata.ts tests/recorder/metadata.test.ts
git commit -m "refactor: extract recorder metadata builders"
```

---

### Task 5: Decoder tests and implementation

**Files:**
- Create: `src/recorder/decoder.ts`
- Create: `tests/recorder/decoder.test.ts`

- [ ] **Step 1: Write tests using fake decoder factory**

Create `tests/recorder/decoder.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { OpusDecoder } from "../../src/recorder/decoder";

class FakeDecoder {
  handlers = new Map<string, (...args: unknown[]) => void>();
  destroyed = false;
  writes: Buffer[] = [];

  on(event: string, handler: (...args: unknown[]) => void) {
    this.handlers.set(event, handler);
    return this;
  }

  write(chunk: Buffer) {
    this.writes.push(chunk);
  }

  removeAllListeners() {
    this.handlers.clear();
  }

  destroy() {
    this.destroyed = true;
  }
}

describe("OpusDecoder", () => {
  it("creates decoder lazily and writes chunks", () => {
    const fake = new FakeDecoder();
    const decoder = new OpusDecoder({ cooldownMs: 30_000, rotateMs: 5_000, createDecoder: () => fake as never, onData: vi.fn() });

    decoder.write(Buffer.from([1, 2, 3]));

    expect(fake.writes).toHaveLength(1);
  });

  it("destroys and recreates after rotation timeout", () => {
    vi.useFakeTimers();
    const created: FakeDecoder[] = [];
    const decoder = new OpusDecoder({
      cooldownMs: 30_000,
      rotateMs: 5_000,
      createDecoder: () => {
        const fake = new FakeDecoder();
        created.push(fake);
        return fake as never;
      },
      onData: vi.fn(),
    });

    decoder.write(Buffer.from([1]));
    vi.advanceTimersByTime(5_001);
    decoder.rotateIfNeeded();
    decoder.write(Buffer.from([2]));

    expect(created).toHaveLength(2);
    expect(created[0].destroyed).toBe(true);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run failing test**

```bash
bun run test tests/recorder/decoder.test.ts
```
Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement decoder module**

Create `src/recorder/decoder.ts`:
```ts
import prism from "prism-media";

export interface OpusDecoderOptions {
  cooldownMs: number;
  rotateMs: number;
  createDecoder?: () => prism.opus.Decoder;
  onData: (pcm: Buffer) => void;
}

export class OpusDecoder {
  private decoder: prism.opus.Decoder | null = null;
  private disabledUntil = 0;
  private createdAt = 0;
  private readonly cooldownMs: number;
  private readonly rotateMs: number;
  private readonly createDecoderFn: () => prism.opus.Decoder;
  private readonly onData: (pcm: Buffer) => void;

  constructor(options: OpusDecoderOptions) {
    this.cooldownMs = options.cooldownMs;
    this.rotateMs = options.rotateMs;
    this.onData = options.onData;
    this.createDecoderFn =
      options.createDecoder ??
      (() => new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48_000 }));
  }

  rotateIfNeeded(): void {
    if (!this.decoder || this.rotateMs <= 0) return;
    if (Date.now() - this.createdAt < this.rotateMs) return;
    this.destroy();
    this.ensureDecoder();
  }

  write(chunk: Buffer): void {
    const decoder = this.ensureDecoder();
    if (!decoder) return;
    try {
      decoder.write(chunk);
    } catch (error) {
      console.warn("[recorder] Opus decoder write failed, cooling down:", error);
      this.coolDown();
    }
  }

  destroy(): void {
    if (!this.decoder) return;
    this.decoder.removeAllListeners();
    this.decoder.destroy();
    this.decoder = null;
    this.createdAt = 0;
  }

  private ensureDecoder(): prism.opus.Decoder | null {
    if (this.decoder) return this.decoder;
    if (Date.now() < this.disabledUntil) return null;
    try {
      const decoder = this.createDecoderFn();
      decoder.on("data", this.onData);
      decoder.on("error", (error) => {
        console.warn("[recorder] Opus decoder error, cooling down:", error);
        this.coolDown();
      });
      this.decoder = decoder;
      this.createdAt = Date.now();
      return decoder;
    } catch (error) {
      console.warn("[recorder] Opus decoder init failed, cooling down:", error);
      this.disabledUntil = Date.now() + this.cooldownMs;
      return null;
    }
  }

  private coolDown(): void {
    this.disabledUntil = Date.now() + this.cooldownMs;
    this.destroy();
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

```bash
bun run test tests/recorder/decoder.test.ts
bun run typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/recorder/decoder.ts tests/recorder/decoder.test.ts
git commit -m "refactor: extract opus decoder lifecycle"
```

---

### Task 6: Segment tests and implementation

**Files:**
- Create: `src/recorder/segment.ts`
- Create: `tests/recorder/segment.test.ts`

- [ ] **Step 1: Write tests for pure filename and rotation decision helpers**

Create `tests/recorder/segment.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { buildSegmentPaths, shouldRotateSegment } from "../../src/recorder/segment";

describe("buildSegmentPaths", () => {
  it("creates matching ogg and json paths", () => {
    expect(buildSegmentPaths("/tmp/user", 123)).toEqual({
      filename: "/tmp/user/123.ogg",
      jsonFilename: "/tmp/user/123.json",
    });
  });
});

describe("shouldRotateSegment", () => {
  it("rotates only when segment limit is exceeded", () => {
    expect(shouldRotateSegment(1_000, 1_499, 500)).toBe(false);
    expect(shouldRotateSegment(1_000, 1_500, 500)).toBe(true);
    expect(shouldRotateSegment(1_000, 2_000, 0)).toBe(false);
  });
});
```

- [ ] **Step 2: Run failing test**

```bash
bun run test tests/recorder/segment.test.ts
```
Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement segment helpers and manager**

Create `src/recorder/segment.ts`:
```ts
import fs from "node:fs";
import path from "node:path";
import prism from "prism-media";
import type { SegmentState } from "../types";

export function buildSegmentPaths(userDir: string, startTime: number): { filename: string; jsonFilename: string } {
  return {
    filename: path.join(userDir, `${startTime}.ogg`),
    jsonFilename: path.join(userDir, `${startTime}.json`),
  };
}

export function shouldRotateSegment(startTime: number, now: number, recordingSegmentMs: number): boolean {
  return recordingSegmentMs > 0 && now - startTime >= recordingSegmentMs;
}

export class SegmentManager {
  private currentSegment: SegmentState | null = null;
  private segmentIndex = 0;

  constructor(
    private readonly userDir: string,
    private readonly recordingSegmentMs: number,
  ) {}

  open(oggPacketStream: NodeJS.ReadableStream): SegmentState {
    const index = this.segmentIndex++;
    const startTime = Date.now();
    const { filename, jsonFilename } = buildSegmentPaths(this.userDir, startTime);
    const oggStream = new prism.opus.OggLogicalBitstream({
      opusHead: new prism.opus.OpusHead({ channelCount: 2, sampleRate: 48_000 }),
      pageSizeControl: { maxPackets: 10 },
      crc: true,
    });
    const out = fs.createWriteStream(filename);
    oggPacketStream.pipe(oggStream).pipe(out);

    this.currentSegment = { index, startTime, endTime: null, filename, jsonFilename, oggStream, out };
    return this.currentSegment;
  }

  close(oggPacketStream: NodeJS.ReadableStream): SegmentState | null {
    if (!this.currentSegment) return null;
    const segment = this.currentSegment;
    segment.endTime = Date.now();
    oggPacketStream.unpipe(segment.oggStream);
    segment.oggStream.end();
    this.currentSegment = null;
    return segment;
  }

  rotateIfNeeded(oggPacketStream: NodeJS.ReadableStream): SegmentState | null {
    if (!this.currentSegment) return null;
    if (!shouldRotateSegment(this.currentSegment.startTime, Date.now(), this.recordingSegmentMs)) return null;
    this.close(oggPacketStream);
    return this.open(oggPacketStream);
  }

  getCurrent(): SegmentState | null {
    return this.currentSegment;
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

```bash
bun run test tests/recorder/segment.test.ts
bun run typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/recorder/segment.ts tests/recorder/segment.test.ts
git commit -m "refactor: extract recording segment manager"
```

---

### Task 7: Audio stream helper

**Files:**
- Create: `src/recorder/audioStream.ts`

- [ ] **Step 1: Create stream helper**

Create `src/recorder/audioStream.ts`:
```ts
import { EndBehaviorType, type VoiceReceiver } from "@discordjs/voice";

export interface AudioStreamHandlers {
  onPacket: (chunk: Buffer) => void;
  onEnd: () => void;
  onError: (error: Error) => void;
}

export function subscribeToAudioStream(
  receiver: VoiceReceiver,
  userId: string,
  handlers: AudioStreamHandlers,
): NodeJS.ReadableStream {
  const audioStream = receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: 3_000,
    },
  });

  audioStream.on("data", handlers.onPacket);
  audioStream.on("end", handlers.onEnd);
  audioStream.on("error", handlers.onError);

  return audioStream;
}
```

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/recorder/audioStream.ts
git commit -m "refactor: extract audio stream subscription"
```

---

### Task 8: Refactor `src/recorder.ts` orchestration

**Files:**
- Modify: `src/recorder.ts`

- [ ] **Step 1: Replace inline helpers with modules**

Edit `src/recorder.ts`:
- Import `collectUserMetadata`, `createSegmentMetadata`.
- Import `OpusDecoder`.
- Import `SegmentManager`.
- Import `subscribeToAudioStream`.
- Use `config.recordingsDir`, `config.recordingSegmentMs`, `config.decoderRotateMs`, `config.decoderCooldownMs`.
- Keep `startRecording(client, channel)` and `stopRecording(guildId)` exports unchanged.
- Remove packet debug logging `Pkt #...`.
- Keep current global web update behavior via `globalThis as PcmBroadcaster`.

Core packet handler shape:
```ts
const broadcaster = globalThis as typeof globalThis & PcmBroadcaster;
const userMetadata = await collectUserMetadata(client, userId, channel);
const segmentManager = new SegmentManager(userDir, config.recordingSegmentMs);
const decoder = new OpusDecoder({
  cooldownMs: config.decoderCooldownMs,
  rotateMs: config.decoderRotateMs,
  onData: (pcm) => {
    if (!broadcaster.broadcastPcmToWeb) return;
    const outBuf = Buffer.alloc(pcm.length / 4);
    for (let i = 0; i < outBuf.length / 2; i++) {
      outBuf.writeInt16LE(pcm.readInt16LE(i * 8), i * 2);
    }
    broadcaster.broadcastPcmToWeb(outBuf, userId);
  },
});

const audioStream = subscribeToAudioStream(receiver, userId, {
  onPacket: (chunk) => {
    if (chunk.length < 8) return;
    segmentManager.rotateIfNeeded(oggPacketStream);
    if (!broadcaster.broadcastPcmToWeb) return;
    decoder.rotateIfNeeded();
    decoder.write(chunk);
  },
  onEnd: () => {
    const segment = segmentManager.close(oggPacketStream);
    decoder.destroy();
    if (segment) {
      const metadata = createSegmentMetadata(userMetadata, segment, sessionId, sessionStartTime, config.recordingSegmentMs);
      fs.writeFileSync(segment.jsonFilename, JSON.stringify(metadata, null, 2));
    }
    broadcaster.updateActiveUser?.(userId, { username: userMetadata.username, avatar: userMetadata.avatarUrl, speaking: false });
  },
  onError: (error) => {
    segmentManager.close(oggPacketStream);
    decoder.destroy();
    console.error(`[recorder] Audio Stream error ${userId}:`, error.message);
  },
});
```

- [ ] **Step 2: Preserve metadata writes on segment finish**

If existing behavior writes JSON when `out` finishes, attach `out.on("finish", ...)` in `SegmentManager.open()` caller after opening current segment. Ensure every closed segment gets JSON metadata, including rotated segments.

- [ ] **Step 3: Run typecheck**

```bash
bun run typecheck
```
Expected: PASS. Fix type errors by narrowing types, not adding `any` unless third-party library lacks exported type.

- [ ] **Step 4: Run tests**

```bash
bun run test
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/recorder.ts src/recorder/audioStream.ts src/recorder/decoder.ts src/recorder/metadata.ts src/recorder/segment.ts src/types.ts
git commit -m "refactor: modularize recorder orchestration"
```

---

### Task 9: Format and lint cleanup

**Files:**
- Modify: all formatted TypeScript/config files touched by Biome.

- [ ] **Step 1: Run formatter**

```bash
bun run format
```
Expected: files formatted.

- [ ] **Step 2: Run linter**

```bash
bun run lint
```
Expected: PASS or actionable warnings. Fix warnings that are in touched code.

- [ ] **Step 3: Run typecheck and tests**

```bash
bun run typecheck
bun run test
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add .
git commit -m "style: format and lint codebase"
```

---

### Task 10: Manual runtime verification

**Files:**
- No required code changes unless verification finds bug.

- [ ] **Step 1: Start app**

Run:
```bash
bun run start
```
Expected: app starts, logs bot ready or fails only due missing env credentials.

- [ ] **Step 2: If env exists, verify recording flow**

Manual steps:
1. Join configured Discord voice channel.
2. Speak for >3 seconds.
3. Confirm `.ogg` file and `.json` metadata are created under `RECORDINGS_DIR`.
4. Keep speaking past `RECORDING_SEGMENT_MS`; confirm segment rotation creates multiple files.
5. Stop app with Ctrl-C; confirm graceful shutdown log.

- [ ] **Step 3: Commit fixes if needed**

```bash
git add src tests package.json biome.json vitest.config.ts tsconfig.json
git commit -m "fix: preserve recorder runtime behavior"
```
Only run if code changed.

---

### Task 11: Final verification

**Files:**
- No changes expected.

- [ ] **Step 1: Run full verification**

```bash
bun run format
bun run lint
bun run typecheck
bun run test
git status --short
```
Expected: formatter stable, lint PASS, typecheck PASS, tests PASS, git status clean or only intentional uncommitted runtime artifacts excluded by `.gitignore`.

- [ ] **Step 2: Review diff summary**

```bash
git log --oneline -8
git diff HEAD~8...HEAD --stat
```
Expected: commits show tooling, config, types, metadata, decoder, segment, stream, recorder refactor, formatting.

- [ ] **Step 3: Report result**

Report:
- Commands run and pass/fail status.
- Runtime verification status.
- Any remaining risks, especially Discord runtime behavior if not manually tested with credentials.

---

## Self-Review

- Spec coverage: tooling, config, shared types, metadata, decoder, segment, audio stream, recorder orchestration, tests, lint/format, and runtime verification are covered.
- Placeholder scan: no TBD/TODO placeholders.
- Type consistency: `UserMetadata`, `SegmentState`, `SegmentMetadata`, `PcmBroadcaster`, `OpusDecoder`, `SegmentManager`, and `subscribeToAudioStream` names are consistent across tasks.
