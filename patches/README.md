# Patches

This directory contains patches for vendor dependencies that have local modifications.

## ffmpeg-headers-fix.patch

**Issue:** Screen share streaming fails with ffmpeg error:
```
[NULL @ ...] Unable to find a suitable output format for 'Mozilla/5.0'
```

**Root Cause:** The `@dank074/discord-video-stream` library's `prepareStream` function passes HTTP headers to ffmpeg without proper quoting. The `fluent-ffmpeg-simplified` library uses `parseArgsStringToArgv` to parse command-line arguments, which splits strings by spaces. This causes the User-Agent header value (with spaces) to be split into multiple separate arguments instead of being kept as a single value.

**Fix:** Wrap the entire headers string in quotes so `parseArgsStringToArgv` treats it as a single argument:
```typescript
// Before (broken)
command.inputOptions(
  "-headers",
  Object.entries(customHeaders)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n"),
);

// After (fixed)
const headersString = Object.entries(customHeaders)
  .map(([k, v]) => `${k}: ${v}`)
  .join("\r\n");
command.inputOptions(`-headers "${headersString}"`);
```

**Applied To:** `vendor/discord-video-stream/src/media/newApi.ts` (lines 263-269)

**Status:** Patch is applied locally. The compiled output in `dist/media/newApi.js` reflects this fix.

**Note:** This is a local patch to the vendor submodule. To make this permanent, it should be submitted as a PR to the upstream repository: https://github.com/dank074/discord-video-stream
