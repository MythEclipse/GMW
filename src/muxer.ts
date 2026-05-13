import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import path from "path";

const recordingsDir = process.env.RECORDINGS_DIR ?? "./recordings";

interface EventMetadata {
  userId: string;
  username: string;
  tag: string;
  displayName?: string;
  avatarUrl?: string;
  bot?: boolean;
  roles?: Array<{ id: string; name: string; position: number }>;
  highestRole?: { id: string; name: string; position: number } | null;
  joinedTimestamp?: number | null;
  sessionId?: string;
  sessionStartTime?: number;
  segmentIndex?: number;
  segmentMs?: number;
  startTime: number;
  endTime: number;
  durationMs: number;
  filename: string;
}

interface ClipInfo {
  oggPath: string;
  jsonPath: string;
  meta: EventMetadata;
}

async function startMuxing() {
  console.log("[muxer] Scanning recordings directory...");
  if (!fs.existsSync(recordingsDir)) {
    console.error("[muxer] Recordings directory not found.");
    return;
  }

  const clips: ClipInfo[] = [];

  // Scan user directories
  const items = fs.readdirSync(recordingsDir);
  console.log(`[muxer] Found ${items.length} directories to scan...`);

  let processedDirs = 0;
  for (const item of items) {
    const itemPath = path.join(recordingsDir, item);
    if (fs.statSync(itemPath).isDirectory()) {
      const files = fs.readdirSync(itemPath);
      for (const file of files) {
        if (file.endsWith(".json")) {
          const jsonPath = path.join(itemPath, file);
          const oggPath = jsonPath.replace(/\.json$/, ".ogg");
          if (fs.existsSync(oggPath)) {
            try {
              // Check if OGG file is valid (not empty and has reasonable size)
              const oggStats = fs.statSync(oggPath);
              if (oggStats.size === 0) {
                console.warn(`[muxer] Skipping empty OGG file: ${oggPath}`);
                continue;
              }

              // Skip files that are too small (less than 1KB likely corrupted)
              if (oggStats.size < 1024) {
                console.warn(
                  `[muxer] Skipping too small OGG file (${oggStats.size} bytes): ${oggPath}`,
                );
                continue;
              }

              // Check if OGG file has valid header (starts with "OggS")
              const oggBuffer = fs.readFileSync(oggPath);
              const oggHeader = oggBuffer.slice(0, 4).toString();
              if (oggHeader !== "OggS") {
                console.warn(
                  `[muxer] Skipping invalid OGG file (bad header): ${oggPath}`,
                );
                continue;
              }

              const meta: EventMetadata = JSON.parse(
                fs.readFileSync(jsonPath, "utf-8"),
              );
              clips.push({ oggPath, jsonPath, meta });
            } catch (e) {
              console.error(
                `[muxer] Failed to read/parse JSON: ${jsonPath}`,
                e,
              );
            }
          }
        }
      }
      processedDirs++;
      const progress = ((processedDirs / items.length) * 100).toFixed(2);
      console.log(
        `[muxer] Scanning progress: ${progress}% (${processedDirs}/${items.length} directories)`,
      );
    }
  }

  if (clips.length === 0) {
    console.log("[muxer] No recording clips found to mux.");
    return;
  }

  // Sort by startTime so chronologically they are in order
  clips.sort((a, b) => a.meta.startTime - b.meta.startTime);

  // Find the global start time
  const globalStartTime = clips[0].meta.startTime;
  console.log(
    `[muxer] Found ${clips.length} clips. Base timestamp: ${globalStartTime}`,
  );

  const command = ffmpeg();
  const filterParts: string[] = [];

  console.log(`[muxer] Creating audio filters for ${clips.length} clips...`);
  clips.forEach((clip, index) => {
    command.input(clip.oggPath);

    // Calculate delay relative to the global start time
    const delayMs = clip.meta.startTime - globalStartTime;

    // FFmpeg filter structure: [0:a]adelay=1000|1000[a0]
    // Setting adelay multiple times covers stereo channels.
    // We ensure all multiple channels get delayed.
    const inputSpecifier = `[${index}:a]`;
    const outputSpecifier = `[pad${index}]`;

    filterParts.push(
      `${inputSpecifier}adelay=${delayMs}|${delayMs}${outputSpecifier}`,
    );

    const progress = (((index + 1) / clips.length) * 100).toFixed(2);
    console.log(
      `[muxer] Filter creation progress: ${progress}% (${index + 1}/${clips.length} clips)`,
    );
  });

  // Merge them using amix
  const amixInputs = clips.map((_, i) => `[pad${i}]`).join("");
  // We add the amix command. dropout_transition=0 avoids volume drop when streams end.
  filterParts.push(
    `${amixInputs}amix=inputs=${clips.length}:dropout_transition=0[out]`,
  );

  const outputFilename = path.join(recordingsDir, `muxed-${Date.now()}.mp3`);

  console.log(`[muxer] Combining clips. This might take a while...`);

  // Using fluent-ffmpeg's complexFilter
  command
    .complexFilter(filterParts, "out")
    .audioCodec("libmp3lame")
    .save(outputFilename)
    .on("progress", (progress) => {
      if (progress.percent) {
        console.log(`[muxer] Progress: ${progress.percent.toFixed(2)}%`);
      }
    })
    .on("end", () => {
      console.log(
        `[muxer] Successfully muxed! Output saved to: ${outputFilename}`,
      );
    })
    .on("error", (err) => {
      console.error(`[muxer] FFmpeg Error:`, err);
    });
}

startMuxing();
