# Session Full Recording Design

## Context

The recorder currently writes per-user OGG segments under `recordings/<userId>/`. Each segment has JSON metadata with user identity, bot flag, segment timing, and filename. The requested addition is a second recording view: one full-session OGG from the time the bot joins a voice channel until it leaves, while preserving the current per-user recording files.

Bot/self audio is excluded before segment creation, so session-level output should only include human participants.

## Goals

- Track one recording session from successful voice join until disconnect/leave.
- Preserve existing per-user OGG segment behavior.
- Create a background full-session OGG/Opus mix after the session ends.
- Store session metadata with duration, participants, segment references, output status, and full recording path.
- Keep muxing failures isolated from voice connection shutdown.

## Non-goals

- Real-time mixed full-session recording.
- Replacing per-user segment recording.
- Dashboard UI for session playback in this phase.
- Database-backed mux job retries in this phase.

## Output structure

A completed session writes:

```text
recordings/
  sessions/
    <recordingSessionId>/
      full.ogg
      session.json
```

`recordingSessionId` is based on guild ID, channel ID, and session start time: `<guildId>-<channelId>-<sessionStartTime>`.

`session.json` contains:

- `sessionId`
- `guildId`
- `channelId`
- `channelName`
- `startTime`
- `endTime`
- `durationMs`
- `status`: `completed`, `failed`, or `empty`
- `outputFile`: relative path to `full.ogg` when present
- `participants`: non-bot users observed in the session
- `segments`: per-user segment metadata references with absolute timing
- `error`: failure message when muxing fails

Per-user segment JSON also records the shared `recordingSessionId` so full-session muxing can identify which files belong to the same join/leave session.

## Lifecycle

1. `startRecording()` creates a session object after the voice connection reaches ready state.
2. Each non-bot speaking user still gets the existing per-user `SegmentManager` flow.
3. Each finished segment is registered with the active session using its metadata path, OGG path, user ID, start time, and end time.
4. `stopRecording(guildId)` or connection destruction finalizes the active session with `endTime`.
5. Finalization starts muxing in the background and does not block disconnect.
6. Muxing writes `session.json` with `empty`, `completed`, or `failed` status.

## Muxing design

The post-processor reads all registered segment metadata for the session. It builds an ffmpeg `filter_complex` that delays each input by `segment.startTime - session.startTime` milliseconds, mixes all delayed inputs with `amix`, and encodes the result to OGG/Opus.

For a session with no human segments, muxing skips ffmpeg and writes `session.json` with `status: "empty"` and the full session duration.

For successful muxing, it writes `full.ogg` and `session.json` with `status: "completed"`.

For failed muxing, it writes `session.json` with `status: "failed"` and the error message.

## Error handling

- Failure to write `session.json` is logged and does not crash shutdown.
- ffmpeg failure is captured in metadata as `status: "failed"`.
- Missing or empty segment files are skipped from the mix and recorded as skipped references if needed.
- Background mux errors never reject `stopRecording()`.

## Testing

- Unit test session metadata creation from join to stop.
- Unit test bot/self users do not register participants or segments.
- Unit test mux filter generation with timeline offsets.
- Unit test empty sessions write `status: "empty"` without calling ffmpeg.
- Unit test stop triggers background finalization without awaiting ffmpeg.
